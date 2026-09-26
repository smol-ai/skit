import { Clock, Effect, FileSystem, Result, Schema } from "effect";
import { Cookies, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isErrno } from "../platform/errno.js";
import {
  InsecureOrigin,
  NoStoredCredentials,
  RegistryOriginInvalid,
  RegistrySelectionAmbiguous,
  TooManyAuthAttempts,
} from "./failures.js";
import { CredentialsUnusable } from "./failures.js";
import { SignInRejected } from "./failures.js";
import { isRegistryTransportError, RegistryHttp } from "./registry-http.js";
import { Renderer } from "../presentation/renderer.js";
import { Data } from "effect";
import type { RegistryRemote } from "./contracts.js";
import { serverDiscoverySchema } from "@smolai/skit-core";
import {
  ConsumerAuthenticatedApi,
  RateLimitedResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  mapRegistryFailureCause,
  registryApiFailureMessage,
  sessionApiMiddleware,
} from "./api-client.js";

export class SignOutUnreachable extends Data.TaggedError("SignOutUnreachable")<{
  origin: string;
  cause: Error;
}> {
  get message() {
    return `Unable to reach Registry ${this.origin}: ${this.cause.message}`;
  }
}
export class SignOutRejected extends Data.TaggedError("SignOutRejected")<{ message: string }> {}

export class SignInUnreachable extends Data.TaggedError("SignInUnreachable")<{
  origin: string;
  cause: Error;
}> {
  get message() {
    return `Unable to reach Registry ${this.origin}: ${this.cause.message}`;
  }
}

/**
 * Sign-in got far enough to say something specific, and the sentence is the value.
 *
 * These were bare `throw new Error(...)` before the conversion, so they classify as
 * OperationFailed exactly as they did. Naming them keeps the error channel truthful without
 * moving any of them onto a different exit code.
 */
export class SignInFailed extends Data.TaggedError("SignInFailed")<{ message: string }> {}

/** Every Registry status this module treats as success. */
const ok = (response: HttpClientResponse) => response.status >= 200 && response.status < 300;

export const AUTH_SCOPES = ["library:sync", "authoring:write", "publication:write"] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

/**
 * `scopes` decodes as plain strings, not the AUTH_SCOPES union: those literals say what this CLI
 * may request at login, not what a Registry may have granted. A scope this build does not know
 * about must not render the whole credential file unusable.
 */
const StoredCredential = Schema.Struct({
  token: Schema.String,
  tokenId: Schema.String,
  tokenPrefix: Schema.String,
  scopes: Schema.Array(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
});

const AuthConfig = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    activeOrigin: Schema.optionalKey(Schema.String),
    defaultRegistry: Schema.optionalKey(Schema.String),
    registryAliases: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    servers: Schema.Record(Schema.String, StoredCredential),
  }),
);

const RegistryErrorResponse = Schema.Struct({ error: Schema.String });
const decodeRegistryErrorResponse = Schema.decodeUnknownEffect(RegistryErrorResponse);
type StoredCredential = typeof StoredCredential.Type;
type AuthConfig = typeof AuthConfig.Type;

const decodeAuthConfig = Schema.decodeUnknownEffect(AuthConfig);

export type ResolvedAuth = {
  origin?: string;
  token?: string;
  tokenId?: string;
  tokenPrefix?: string;
  scopes?: readonly string[];
  expiresAt?: string;
  source: "environment" | "stored" | "none";
};

export type RegistryConfigurationError =
  | CredentialsUnusable
  | RegistryOriginInvalid
  | RegistryAliasNotFound
  | RegistrySelectionAmbiguous;

type AuthStatusCredential = {
  origin: string;
  aliases: string[];
  tokenPrefix: string;
  scopes: readonly string[];
  expiresAt?: string;
  expiry: "known" | "unknown";
  expired: boolean;
  isDefault: boolean;
  source: "stored" | "environment";
};

export function authPath(home?: string) {
  return join(resolve(home ?? process.env.SKIT_HOME ?? join(homedir(), ".skit")), "auth.json");
}

export function readConfigEffect(
  home?: string,
): Effect.Effect<AuthConfig, CredentialsUnusable, FileSystem.FileSystem> {
  const path = authPath(home);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchTag("PlatformError", (error) => {
        if (isErrno(error, "ENOENT")) return Effect.succeed(undefined);
        return Effect.fail(
          new CredentialsUnusable({
            path,
            reason: isErrno(error, "EACCES", "EPERM") ? "unreadable" : "invalid",
          }),
        );
      }),
    );
    if (text === undefined) return { schemaVersion: 1 as const, registryAliases: {}, servers: {} };
    // This configuration reader deliberately classifies malformed values as unusable.
    return yield* decodeAuthConfig(text).pipe(
      Effect.mapError(() => new CredentialsUnusable({ path, reason: "invalid" })),
    );
  });
}

const writeConfigEffect = Effect.fn("Auth.writeConfig")(function* (
  config: AuthConfig,
  home?: string,
  options: { readonly promoteSoleRegistry?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = authPath(home);
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  const { activeOrigin: _legacyActiveOrigin, ...withoutActiveOrigin } = config;
  const origins = Object.keys(config.servers);
  let normalized = withoutActiveOrigin;
  if (
    options.promoteSoleRegistry !== false &&
    !normalized.defaultRegistry &&
    origins.length === 1
  ) {
    const origin = origins[0];
    const aliases = normalized.registryAliases ?? {};
    const existing = Object.entries(aliases).find(([, value]) => value === origin)?.[0];
    let name = existing ?? "default";
    for (let suffix = 2; aliases[name] && aliases[name] !== origin; suffix += 1)
      name = `default-${suffix}`;
    normalized = {
      ...normalized,
      registryAliases: existing ? aliases : { ...aliases, [name]: origin },
      defaultRegistry: name,
    };
  }
  yield* fs.writeFileString(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  // The write mode is subject to umask; credentials get the permission set explicitly.
  yield* fs.chmod(temporary, 0o600);
  yield* fs.rename(temporary, path);
});

const resolveSelectedOriginEffect = Effect.fnUntraced(function* (options: {
  readonly home?: string;
  readonly registry?: string;
  readonly durableOrigin?: string;
  readonly command?: string;
}) {
  if (options.durableOrigin) return yield* parseOrigin(options.durableOrigin);
  const config = yield* readConfigEffect(options.home);
  if (options.registry) {
    if (options.registry.includes("://")) return yield* parseOrigin(options.registry);
    const aliased = config.registryAliases?.[options.registry];
    if (!aliased) return yield* new RegistryAliasNotFound({ name: options.registry });
    return aliased;
  }
  if (process.env.SKIT_SERVER_URL) return yield* parseOrigin(process.env.SKIT_SERVER_URL);
  if (config.defaultRegistry) {
    const defaultOrigin = config.registryAliases?.[config.defaultRegistry];
    if (defaultOrigin) return defaultOrigin;
  }
  const origins = Object.keys(config.servers).sort();
  if (origins.length === 1) return origins[0];
  if (origins.length > 1)
    return yield* new RegistrySelectionAmbiguous({
      origins,
      command: `${options.command ?? "skit <command>"} --registry <alias-or-origin>`,
    });
  return undefined;
});

export const resolveAuthEffect = Effect.fnUntraced(function* (
  home?: string,
  registry?: string,
  durableOrigin?: string,
  command?: string,
): Effect.fn.Return<
  ResolvedAuth,
  CredentialsUnusable | RegistryOriginInvalid | RegistryAliasNotFound | RegistrySelectionAmbiguous,
  FileSystem.FileSystem
> {
  const config = yield* readConfigEffect(home);
  const origin = yield* resolveSelectedOriginEffect({ home, registry, durableOrigin, command });
  const stored = origin ? config.servers[origin] : undefined;
  const environmentOrigin = process.env.SKIT_SERVER_URL
    ? yield* parseOrigin(process.env.SKIT_SERVER_URL)
    : undefined;
  const environmentToken = process.env.SKIT_TOKEN;
  const useEnvironment = Boolean(environmentToken && environmentOrigin === origin);
  return {
    origin,
    token: useEnvironment ? environmentToken : stored?.token,
    tokenId: useEnvironment ? undefined : stored?.tokenId,
    tokenPrefix: useEnvironment ? environmentToken?.slice(0, 18) : stored?.tokenPrefix,
    scopes: useEnvironment ? undefined : stored?.scopes,
    expiresAt: useEnvironment ? undefined : stored?.expiresAt,
    source: useEnvironment ? "environment" : stored ? "stored" : "none",
  };
});

export class RegistryAliasInvalid extends Data.TaggedError("RegistryAliasInvalid")<{
  name: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message() {
    return `Invalid Registry name: ${this.name}`;
  }
}

export class RegistryAliasConflict extends Data.TaggedError("RegistryAliasConflict")<{
  name: string;
}> {
  readonly code = "CONFLICT" as const;
  get message() {
    return `Registry name already exists: ${this.name}`;
  }
}

export class RegistryAliasNotFound extends Data.TaggedError("RegistryAliasNotFound")<{
  name: string;
}> {
  readonly code = "NOT_FOUND" as const;
  get message() {
    return `Unknown Registry name: ${this.name}`;
  }
}

export class DefaultRegistryNotConfigured extends Data.TaggedError(
  "DefaultRegistryNotConfigured",
)<{}> {
  readonly code = "NOT_FOUND" as const;
  get message() {
    return "No default Registry is configured; pass a Registry alias or HTTPS origin";
  }
}

export class RegistrySelectionConflict extends Data.TaggedError("RegistrySelectionConflict")<{
  locator: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `A concrete Registry locator cannot be combined with --registry: ${this.locator}`;
  }
}

export class RegistrySelectionRequiresRegistrySource extends Data.TaggedError(
  "RegistrySelectionRequiresRegistrySource",
)<{ source: string }> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `--registry requires a Registry source: ${this.source}`;
  }
}

const validateRegistryAlias = (name: string) =>
  /^[a-z][a-z0-9-]*$/.test(name)
    ? Effect.succeed(name)
    : Effect.fail(new RegistryAliasInvalid({ name }));

export const listRegistryRemotesEffect = Effect.fn("Registry.listRemotes")(function* (
  home?: string,
) {
  const config = yield* readConfigEffect(home);
  return Object.entries(config.registryAliases ?? {}).map(([name, origin]) => ({
    name,
    origin,
    isDefault: config.defaultRegistry === name,
  }));
});

export const addRegistryRemoteEffect = Effect.fn("Registry.addRemote")(function* (
  name: string,
  originInput: string,
  home?: string,
) {
  yield* validateRegistryAlias(name);
  const origin = yield* parseOrigin(originInput);
  const config = yield* readConfigEffect(home);
  if (config.registryAliases?.[name]) return yield* new RegistryAliasConflict({ name });
  const next: AuthConfig = {
    ...config,
    registryAliases: { ...config.registryAliases, [name]: origin },
  };
  yield* writeConfigEffect(next, home);
  return { name, origin, isDefault: false } satisfies RegistryRemote;
});

export const defaultRegistryRemoteEffect = Effect.fn("Registry.defaultRemote")(function* (
  name: string,
  home?: string,
) {
  yield* validateRegistryAlias(name);
  const config = yield* readConfigEffect(home);
  const origin = config.registryAliases?.[name];
  if (!origin) return yield* new RegistryAliasNotFound({ name });
  yield* writeConfigEffect({ ...config, defaultRegistry: name }, home);
  return { name, origin, isDefault: true } satisfies RegistryRemote;
});

export const removeRegistryRemoteEffect = Effect.fn("Registry.removeRemote")(function* (
  name: string,
  home?: string,
) {
  yield* validateRegistryAlias(name);
  const config = yield* readConfigEffect(home);
  if (!config.registryAliases?.[name]) return yield* new RegistryAliasNotFound({ name });
  const { [name]: removed, ...registryAliases } = config.registryAliases;
  const { defaultRegistry: _defaultRegistry, ...configWithoutDefault } = config;
  yield* writeConfigEffect(
    config.defaultRegistry === name
      ? { ...configWithoutDefault, registryAliases }
      : { ...config, registryAliases },
    home,
    { promoteSoleRegistry: false },
  );
  return { name, origin: removed, isDefault: false } satisfies RegistryRemote;
});

/** Select a Registry without letting a device-local name enter durable Source state. */
export const resolveRegistryLocatorEffect = Effect.fn("Registry.resolveLocator")(function* (
  input: string,
  options: { readonly registry?: string; readonly home?: string } = {},
) {
  const match = input.match(/^skit:\/\/([^/]+)\/(.+)$/);
  if (match && options.registry) return yield* new RegistrySelectionConflict({ locator: input });
  const config = yield* readConfigEffect(options.home);
  if (match) {
    const origin = `https://${match[1]}`;
    return { input, origin, token: config.servers[origin]?.token };
  }
  if (!options.registry) return { input };
  if (!input.startsWith("skit:"))
    return yield* new RegistrySelectionRequiresRegistrySource({ source: input });
  const origin = options.registry.includes("://")
    ? yield* parseOrigin(options.registry)
    : config.registryAliases?.[options.registry];
  if (!origin) return yield* new RegistryAliasNotFound({ name: options.registry });
  const credential = config.servers[origin];
  return { input, origin, token: credential?.token };
});

// URL syntax errors retain their generic command classification; programming defects do not.
export const parseOrigin = (input: string) =>
  Schema.decodeUnknownEffect(Schema.URLFromString)(input).pipe(
    Effect.map((url) => url.origin),
    Effect.mapError(() => new RegistryOriginInvalid({ origin: input })),
  );

const validateAuthenticationOrigin = Effect.fnUntraced(function* (input: string) {
  const origin = yield* parseOrigin(input).pipe(
    Effect.mapError(() => new InsecureOrigin({ purpose: "authentication" })),
  );
  if (
    !origin.startsWith("https://") &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
  )
    return yield* new InsecureOrigin({ purpose: "authentication" });
  return origin;
});

/** Resolve a device-local login selector before asking the user for credentials. */
export const resolveLoginTargetEffect = Effect.fn("Auth.resolveLoginTarget")(function* (
  selectedRegistry?: string,
  home?: string,
) {
  const config = yield* readConfigEffect(home);
  if (selectedRegistry?.includes("://"))
    return yield* validateAuthenticationOrigin(selectedRegistry);
  const name = selectedRegistry ?? config.defaultRegistry;
  if (!name) return yield* new DefaultRegistryNotConfigured();
  const origin = config.registryAliases?.[name];
  if (!origin) {
    if (selectedRegistry) return yield* new RegistryAliasNotFound({ name });
    return yield* new DefaultRegistryNotConfigured();
  }
  return yield* validateAuthenticationOrigin(origin);
});

export function resolveAuthForOriginEffect(
  originInput: string,
  home?: string,
): Effect.Effect<ResolvedAuth, RegistryOriginInvalid | CredentialsUnusable, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const origin = yield* parseOrigin(originInput);
    const environmentOrigin = process.env.SKIT_SERVER_URL
      ? yield* parseOrigin(process.env.SKIT_SERVER_URL)
      : undefined;
    const environmentToken = process.env.SKIT_TOKEN;
    if (environmentToken && environmentOrigin === origin)
      return {
        origin,
        token: environmentToken,
        tokenPrefix: environmentToken.slice(0, 18),
        source: "environment",
      };
    const config = yield* readConfigEffect(home);
    const stored = config.servers[origin];
    return {
      origin,
      token: stored?.token,
      tokenId: stored?.tokenId,
      tokenPrefix: stored?.tokenPrefix,
      scopes: stored?.scopes,
      expiresAt: stored?.expiresAt,
      source: stored ? "stored" : "none",
    };
  });
}

/** Check the saved bearer before collecting new credentials. No Library data is changed. */
export const reuseLoginEffect = Effect.fn("Auth.reuseLogin")(function* (input: {
  origin: string;
  scopes: readonly string[];
  alias?: string;
  home?: string;
}) {
  const auth = yield* resolveAuthForOriginEffect(input.origin, input.home);
  if (!auth.token || !auth.scopes || !input.scopes.every((scope) => auth.scopes?.includes(scope)))
    return undefined;
  if (auth.expiresAt) {
    const expiry = Date.parse(auth.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= (yield* Clock.currentTimeMillis)) return undefined;
  }
  const config = yield* readConfigEffect(input.home);
  if (input.alias && config.registryAliases?.[input.alias] !== input.origin) return undefined;
  const http = yield* (yield* RegistryHttp).client;
  const response = yield* http
    .execute(
      HttpClientRequest.get(new URL("/api/library/portable", input.origin).href).pipe(
        HttpClientRequest.bearerToken(auth.token),
      ),
    )
    .pipe(Effect.mapError((cause) => new SignInUnreachable({ origin: input.origin, cause })));
  if (response.status === 401) return undefined;
  if (response.status !== 200) {
    const body = yield* response.json.pipe(
      Effect.flatMap(decodeRegistryErrorResponse),
      Effect.mapError(
        () => new SignInFailed({ message: `Credential check failed (${response.status})` }),
      ),
    );
    if (
      !(
        (response.status === 404 && body.error === "library_not_found") ||
        (response.status === 403 && body.error === "insufficient_scope")
      )
    )
      return yield* new SignInFailed({ message: `Credential check failed (${response.status})` });
  }
  const alias =
    input.alias ??
    Object.entries(config.registryAliases ?? {}).find(([, origin]) => origin === input.origin)?.[0];
  return {
    origin: input.origin,
    tokenPrefix: auth.tokenPrefix ?? "",
    scopes: auth.scopes,
    ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
    ...(alias ? { alias } : {}),
    ...(config.defaultRegistry ? { defaultRegistry: config.defaultRegistry } : {}),
    alreadyAuthenticated: true,
    credentialPath: authPath(input.home),
  };
});

export const authStatusCommand = Effect.fn("CLI.authStatus")(function* (
  home?: string,
  selectedRegistry?: string,
) {
  const config = yield* readConfigEffect(home);
  const selectedOrigin = selectedRegistry
    ? selectedRegistry.includes("://")
      ? yield* parseOrigin(selectedRegistry)
      : config.registryAliases?.[selectedRegistry]
    : undefined;
  if (selectedRegistry && !selectedOrigin)
    return yield* new RegistryAliasNotFound({ name: selectedRegistry });
  const defaultOrigin = config.defaultRegistry
    ? config.registryAliases?.[config.defaultRegistry]
    : undefined;
  const now = yield* Clock.currentTimeMillis;
  const credentials: AuthStatusCredential[] = Object.entries(config.servers)
    .filter(([origin]) => !selectedOrigin || origin === selectedOrigin)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([origin, credential]) => ({
      origin,
      aliases: Object.entries(config.registryAliases ?? {})
        .filter(([, value]) => value === origin)
        .map(([name]) => name)
        .sort(),
      tokenPrefix: credential.tokenPrefix,
      scopes: credential.scopes,
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      expiry: credential.expiresAt ? ("known" as const) : ("unknown" as const),
      expired: credential.expiresAt ? Date.parse(credential.expiresAt) <= now : false,
      isDefault: defaultOrigin === origin,
      source: "stored" as const,
    }));
  const environmentOrigin = process.env.SKIT_SERVER_URL
    ? yield* parseOrigin(process.env.SKIT_SERVER_URL)
    : undefined;
  const environmentToken = process.env.SKIT_TOKEN;
  if (
    environmentOrigin &&
    environmentToken &&
    (!selectedOrigin || selectedOrigin === environmentOrigin)
  )
    credentials.push({
      origin: environmentOrigin,
      aliases: [],
      tokenPrefix: environmentToken.slice(0, 18),
      scopes: [],
      expiry: "unknown",
      expired: false,
      isDefault: defaultOrigin === environmentOrigin,
      source: "environment",
    });
  return { credentials };
});

/**
 * Sign in, mint a CLI credential, and end the temporary session that minted it.
 *
 * One Scope owns every request and body read, so an interrupted login releases the connection
 * rather than leaving a response streaming. The order is deliberate and unchanged: the temporary
 * session is always signed out, even when credential creation failed, and a credential that was
 * created but could not be stored — or whose sign-out failed — is revoked rather than left live.
 * Those cleanups are the existing behaviour carried into the Scope, not new guarantees: a process
 * killed outright can still leave a live token, and the messages say so.
 */
export const loginEffect = Effect.fn("Auth.login")(function* (input: {
  origin: string;
  email: string;
  password: string;
  scopes: AuthScope[];
  alias?: string;
  home?: string;
}) {
  const origin = yield* validateAuthenticationOrigin(input.origin);
  const config = yield* readConfigEffect(input.home);
  if (input.alias) {
    yield* validateRegistryAlias(input.alias);
    const existingAlias = config.registryAliases?.[input.alias];
    if (existingAlias && existingAlias !== origin)
      return yield* new RegistryAliasConflict({ name: input.alias });
  }
  const existing = config.servers[origin];
  const http = yield* (yield* RegistryHttp).client;
  const send = (
    url: URL,
    init: {
      readonly method?: "GET" | "POST" | "PUT" | "DELETE";
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    } = {},
  ): Effect.Effect<HttpClientResponse, SignInUnreachable> => {
    let request = HttpClientRequest.make(init.method ?? "GET")(url, { headers: init.headers });
    if (init.body !== undefined)
      request = HttpClientRequest.bodyText(request, init.body, "application/json");
    return http
      .execute(request)
      .pipe(Effect.mapError((error) => new SignInUnreachable({ origin, cause: error.cause })));
  };

  const discoveryResponse = yield* send(new URL("/.well-known/skit", origin), { method: "GET" });
  if (!ok(discoveryResponse))
    return yield* new SignInFailed({
      message: `Registry discovery failed (${discoveryResponse.status})`,
    });
  const discovery = yield* discoveryResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(serverDiscoverySchema)),
    Effect.mapError(
      (error) => new SignInFailed({ message: `Registry discovery is invalid: ${error.message}` }),
    ),
  );
  const unsupportedScopes = input.scopes.filter((scope) => !discovery.scopes.includes(scope));
  if (unsupportedScopes.length > 0)
    return yield* new SignInFailed({
      message: `Registry does not support requested scopes: ${unsupportedScopes.join(", ")}`,
    });
  /** The Registry's own words for a rejected request, in the shape every branch reported. */
  const rejected = Effect.fn("Auth.rejected")(function* (
    response: HttpClientResponse,
    context: string,
  ) {
    const body = yield* response.json.pipe(
      Effect.catchTag("HttpClientError", () => Effect.succeed({})),
    );
    if (response.status === 401) return yield* new SignInRejected({ context });
    if (response.status === 429) return yield* new TooManyAuthAttempts();
    const detail = yield* decodeRegistryErrorResponse(body).pipe(
      Effect.map(({ error }) => error),
      Effect.orElseSucceed(() => "unknown_error"),
    );
    return yield* new SignInFailed({
      message: `${context} failed (${response.status}): ${detail}`,
    });
  });
  const signIn = yield* send(new URL("/api/auth/sign-in/email", origin), {
    method: "POST",
    // A CLI can self-assert Origin; this preserves Better Auth compatibility rather than
    // acting as a security boundary. Browser requests still receive real origin enforcement.
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  if (!ok(signIn)) return yield* rejected(signIn, "Sign in");
  const cookie = Cookies.toCookieHeader(signIn.cookies);
  if (!cookie) return yield* new SignInFailed({ message: "Sign in did not establish a session" });
  const sessionClient = yield* HttpApiClient.makeWith(ConsumerAuthenticatedApi, {
    httpClient: http,
    baseUrl: origin,
  }).pipe(Effect.provide(sessionApiMiddleware(cookie, origin)));
  const revoke = (credential: StoredCredential) =>
    HttpApiClient.makeWith(ConsumerAuthenticatedApi, { httpClient: http, baseUrl: origin }).pipe(
      Effect.provide(authenticatedApiMiddleware(credential.token)),
      Effect.flatMap((client) =>
        client.tokens.revoke({
          params: { token_id: credential.tokenId },
          responseMode: "response-only",
        }),
      ),
      Effect.mapError((error) =>
        isRegistryTransportError(error)
          ? new SignInUnreachable({ origin, cause: error.cause })
          : new SignInFailed({ message: "Credential cleanup request could not be encoded" }),
      ),
    );

  const signOutRequest = () =>
    send(new URL("/api/auth/sign-out", origin), {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    });
  // The temporary session and an unsaved credential are resources from here on, not steps.
  //
  // The promise implementation reached its sign-out because nothing could cancel it; a native
  // login can be interrupted while minting, which would otherwise leave the session live. These
  // finalizers run on every exit, including interruption, and are best-effort: the ordinary paths
  // below still report their own failures, and a killed process can still leave both live.
  let signedOut = false;
  let unsaved: StoredCredential | undefined;
  yield* Effect.addFinalizer(() => (signedOut ? Effect.void : Effect.ignore(signOutRequest())));
  // Registered second, so it runs first: the credential is revoked before the session ends.
  yield* Effect.addFinalizer(() => (unsaved ? Effect.ignore(revoke(unsaved)) : Effect.void));

  const expiresAt = new Date(
    (yield* Clock.currentTimeMillis) + 90 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const creation = yield* Effect.result(
    Effect.gen(function* () {
      const body = yield* sessionClient.tokens
        .create({
          payload: {
            name: `skit CLI on ${hostname()}`,
            scopes: input.scopes,
            expires_at: expiresAt,
          },
        })
        .pipe(
          (effect) => mapRegistryFailureCause(effect, (error) => error),
          Effect.mapError((error) =>
            Schema.is(UnauthorizedResponse)(error)
              ? new SignInRejected({ context: "Credential creation" })
              : Schema.is(RateLimitedResponse)(error)
                ? new TooManyAuthAttempts()
                : isSuccessfulResponseDecodeFailure(error, [201])
                  ? new SignInFailed({
                      message:
                        "Credential was created but its response did not match the Registry contract",
                    })
                  : new SignInFailed({
                      message: registryApiFailureMessage("Credential creation", error, {
                        defaultStatus: 400,
                      }),
                    }),
          ),
        );
      return {
        token: body.token,
        tokenId: body.token_id,
        tokenPrefix: body.token_prefix,
        scopes: body.scopes,
        expiresAt: typeof body.expires_at === "string" ? body.expires_at : undefined,
      } satisfies StoredCredential;
    }),
  );
  const created = Result.isSuccess(creation) ? creation.success : undefined;
  unsaved = created;

  // The temporary session is signed out whether or not the credential was created.
  // Marked before the request, not after: the finalizer covers a sign-out that was never
  // reached, and must not race a second one against a request already in flight.
  signedOut = true;
  const signOut = yield* signOutRequest();
  if (!ok(signOut)) {
    const cleanup = created ? yield* revoke(created) : undefined;
    unsaved = undefined;
    const original = Result.isFailure(creation) ? `: ${creation.failure.message}` : "";
    if (created && cleanup && !ok(cleanup) && ![401, 404].includes(cleanup.status))
      return yield* new SignInFailed({
        message: `Sign out and credential cleanup failed; token ${created.tokenId} (${created.tokenPrefix}) may still be live and the temporary session may also be live`,
      });
    const detail = yield* signOut.text.pipe(
      Effect.catchTag("HttpClientError", () => Effect.succeed("")),
    );
    return yield* new SignInFailed({
      message: `Sign out failed (${signOut.status}): ${detail.slice(0, 500)}; the CLI credential was not saved${original}`,
    });
  }
  if (Result.isFailure(creation)) return yield* Effect.fail(creation.failure);
  if (!created) return yield* new SignInFailed({ message: "Credential creation failed" });

  // The decoded config is the file's shape, not a scratch object: build the next one.
  const firstRegistry = Object.keys(config.servers).length === 0 && !config.defaultRegistry;
  const existingOriginAlias = Object.entries(config.registryAliases ?? {}).find(
    ([, value]) => value === origin,
  )?.[0];
  let initialAlias = input.alias ?? existingOriginAlias ?? "default";
  for (
    let suffix = 2;
    config.registryAliases?.[initialAlias] && config.registryAliases[initialAlias] !== origin;
    suffix += 1
  )
    initialAlias = `default-${suffix}`;
  const configuredAlias = input.alias ?? (firstRegistry ? initialAlias : undefined);
  const signedIn: AuthConfig = {
    ...config,
    ...(configuredAlias
      ? { registryAliases: { ...config.registryAliases, [configuredAlias]: origin } }
      : {}),
    ...(firstRegistry ? { defaultRegistry: initialAlias } : {}),
    servers: { ...config.servers, [origin]: created },
  };
  const stored = yield* Effect.result(writeConfigEffect(signedIn, input.home));
  if (Result.isFailure(stored)) {
    const cleanup = yield* revoke(created);
    unsaved = undefined;
    if (!ok(cleanup) && ![401, 404].includes(cleanup.status))
      return yield* new SignInFailed({
        message: `Credential storage and cleanup failed; token ${created.tokenId} (${created.tokenPrefix}) may still be live`,
      });
    return yield* Effect.fail(stored.failure);
  }
  // Stored: an interrupt after this point must not revoke the credential the caller now has.
  unsaved = undefined;

  let warning: string | undefined;
  if (existing) {
    const replaced = yield* revoke(existing);
    if (!ok(replaced) && ![401, 404].includes(replaced.status))
      warning = `The new credential is active, but previous token ${existing.tokenId} (${existing.tokenPrefix}) could not be revoked and may still be live`;
  }
  return {
    origin,
    tokenPrefix: created.tokenPrefix,
    scopes: created.scopes,
    ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
    ...(warning ? { warning } : {}),
    ...(configuredAlias ? { alias: configuredAlias } : {}),
    ...(firstRegistry ? { defaultRegistry: initialAlias } : {}),
    alreadyAuthenticated: false,
    credentialPath: authPath(input.home),
  };
});

/**
 * Revoke the stored credential and forget it locally.
 *
 * The local forget happens whether or not the Registry accepted the revocation: a credential the
 * server already rejected or lost is still not one this machine should keep offering.
 */
export const logoutEffect = Effect.fn("Auth.logout")(function* (
  home?: string,
  selectedOrigin?: string,
) {
  const config = yield* readConfigEffect(home);
  const origins = Object.keys(config.servers).sort();
  const origin = selectedOrigin
    ? selectedOrigin.includes("://")
      ? yield* parseOrigin(selectedOrigin)
      : config.registryAliases?.[selectedOrigin]
    : origins.length === 1
      ? origins[0]
      : origins.length > 1
        ? yield* new RegistrySelectionAmbiguous({
            origins,
            command: "skit auth logout <origin-or-alias>",
          })
        : undefined;
  if (selectedOrigin && !origin) return yield* new RegistryAliasNotFound({ name: selectedOrigin });
  const credential = origin ? config.servers[origin] : undefined;
  if (!origin || !credential) return yield* new NoStoredCredentials();
  const http = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(ConsumerAuthenticatedApi, {
    httpClient: http,
    baseUrl: origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(credential.token)));
  const response = yield* client.tokens
    .revoke({ params: { token_id: credential.tokenId }, responseMode: "response-only" })
    .pipe(
      Effect.mapError((error) =>
        isRegistryTransportError(error)
          ? new SignOutUnreachable({ origin, cause: error.cause })
          : new SignOutRejected({ message: "Logout request could not be encoded" }),
      ),
    );
  const ok = response.status >= 200 && response.status < 300;
  if (!ok && ![401, 404].includes(response.status)) {
    const body = yield* response.json.pipe(
      Effect.catchTag("HttpClientError", () => Effect.succeed({})),
    );
    if (response.status === 429) return yield* new TooManyAuthAttempts();
    const detail = yield* decodeRegistryErrorResponse(body).pipe(
      Effect.map(({ error }) => error),
      Effect.orElseSucceed(() => "unknown_error"),
    );
    return yield* new SignOutRejected({
      message: `Logout failed (${response.status}): ${detail}`,
    });
  }
  const { [origin]: _revoked, ...servers } = config.servers;
  yield* writeConfigEffect({ ...config, servers }, home);
  return { origin, revoked: ok };
});

export const authLogoutCommand = Effect.fn("CLI.authLogout")(function* (
  home?: string,
  selectedOrigin?: string,
) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Revoking CLI credential",
    Effect.scoped(logoutEffect(home, selectedOrigin)),
  );
});
