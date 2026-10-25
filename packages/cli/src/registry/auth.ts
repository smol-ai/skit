import { configurationForHome, SkitConfiguration } from "../configuration/skit-configuration.js";
import { withConfigurationWriter } from "../configuration-writer.js";
import {
  Clock,
  Config,
  Duration,
  Effect,
  FileSystem,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { Cookies, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ChildProcessSpawner } from "effect/process";
import type { HttpClientResponse } from "effect/http/HttpClientResponse";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isErrno } from "../platform/errno.js";
import {
  CredentialsUnusable,
  DeviceLoginEnded,
  DeviceLoginUnavailable,
  NoStoredCredentials,
  RegistryAliasNotFound,
  RegistryOriginInvalid,
  RegistrySelectionAmbiguous,
  RegistrySelectionConflict,
  RegistrySelectionRequiresRegistrySource,
  RegistryUnreachable,
  SignInFailed,
  SignInRejected,
  SignOutRejected,
  TooManyAuthAttempts,
} from "./failures.js";
import { isRegistryTransportError, RegistryHttp } from "./registry-http.js";
import {
  osTokenStorage,
  readStoredToken,
  removeStoredToken,
  writeStoredToken,
} from "./credential-store.js";
import { Renderer } from "../presentation/renderer.js";
import { serverDiscoverySchema } from "@smolai/skit-core";
import {
  ApiErrorBody,
  ConsumerAuthenticatedApi,
  RateLimitedResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  registryApiFailureMessage,
  sessionApiMiddleware,
} from "./api-client.js";

/** Every Registry status this module treats as success. */
const ok = (response: HttpClientResponse) => response.status >= 200 && response.status < 300;

export const AUTH_SCOPES = ["library:sync", "authoring:write", "publication:write"] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

export { parseOrigin } from "./accounts.js";
export type { ResolvedAuth } from "./accounts.js";
import {
  AuthConfig,
  RegistryAccounts,
  environmentCredential,
  validateAuthenticationOrigin,
  parseOrigin,
  type StoredCredential,
  type ResolvedAuth,
} from "./accounts.js";
const decodeAuthConfig = Schema.decodeUnknownEffect(AuthConfig);
const accountEnvironment = Effect.gen(function* () {
  const { registryOrigin, registryToken } = yield* SkitConfiguration;
  return {
    origin: registryOrigin,
    token: registryToken === undefined ? undefined : Redacted.value(registryToken),
  };
});
const readAccounts = Effect.fn("Auth.readAccounts")(function* (home?: string) {
  return new RegistryAccounts(yield* readConfigEffect(home), yield* accountEnvironment);
});

export type RegistryConfigurationError =
  | Config.ConfigError
  | CredentialsUnusable
  | RegistryOriginInvalid
  | RegistryAliasNotFound
  | RegistrySelectionAmbiguous;

export const authPath = Effect.fn("Auth.path")(function* (home?: string) {
  return (yield* configurationForHome(home)).authPath;
});

/** auth.json exactly as written: tokens kept in an OS store are absent. */
function readAuthDocument(home?: string) {
  return Effect.gen(function* () {
    const path = yield* authPath(home);
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

/**
 * The account configuration with each stored token in place, wherever it is kept. A token the OS
 * store cannot supply is left absent; requests then go unauthenticated and ask the user to log in
 * again, rather than every command failing on a locked keychain.
 */
export function readConfigEffect(home?: string) {
  return Effect.gen(function* () {
    const path = yield* authPath(home);
    const config = yield* readAuthDocument(home);
    const servers: Record<string, StoredCredential> = {};
    for (const [origin, credential] of Object.entries(config.servers)) {
      const token =
        credential.token === undefined && credential.tokenStorage !== undefined
          ? yield* readStoredToken(credential.tokenStorage, path, origin)
          : undefined;
      servers[origin] = token === undefined ? credential : { ...credential, token };
    }
    return { ...config, servers };
  });
}

/**
 * Write the account configuration, keeping each token in the OS store when one accepts it and in
 * this 0600 file otherwise. Store items are written before the file names them and removed only
 * after the file stops naming them, so an interruption never leaves the file pointing at nothing.
 */
const writeConfigEffect = Effect.fn("Auth.writeConfig")(function* (
  config: AuthConfig,
  home?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* authPath(home);
  const previous = yield* Effect.option(readAuthDocument(home));
  const storage = osTokenStorage();
  const servers: Record<string, StoredCredential> = {};
  for (const [origin, credential] of Object.entries(config.servers)) {
    // A token this run could not read stays wherever it already is.
    if (credential.token === undefined) {
      servers[origin] = credential;
      continue;
    }
    const { token, tokenStorage: _previous, ...metadata } = credential;
    servers[origin] =
      storage !== undefined && (yield* writeStoredToken(storage, path, origin, token))
        ? { ...metadata, tokenStorage: storage }
        : { ...metadata, token };
  }
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  yield* fs.writeFileString(temporary, `${JSON.stringify({ ...config, servers }, null, 2)}\n`, {
    mode: 0o600,
  });
  // The write mode is subject to umask; credentials get the permission set explicitly.
  yield* fs.chmod(temporary, 0o600);
  yield* fs.rename(temporary, path);
  if (Option.isNone(previous)) return;
  for (const [origin, credential] of Object.entries(previous.value.servers))
    if (
      credential.tokenStorage !== undefined &&
      servers[origin]?.tokenStorage !== credential.tokenStorage
    )
      yield* removeStoredToken(credential.tokenStorage, path, origin);
});

export const resolveAuthEffect = Effect.fnUntraced(function* (
  home?: string,
  registry?: string,
  durableOrigin?: string,
  command?: string,
): Effect.fn.Return<
  ResolvedAuth,
  RegistryConfigurationError,
  FileSystem.FileSystem | SkitConfiguration | ChildProcessSpawner.ChildProcessSpawner
> {
  const accounts = yield* readAccounts(home);
  return yield* accounts.credential(
    yield* accounts.select(registry, "ambient", { durableOrigin, command }),
  );
});

export const listRegistryRemotesEffect = Effect.fn("Registry.listRemotes")(function* (
  home?: string,
) {
  return (yield* readAccounts(home)).remotes();
});

export const addRegistryRemoteEffect = Effect.fn("Registry.addRemote")(
  function* (name: string, originInput: string, home?: string) {
    const result = yield* (yield* readAccounts(home)).addAlias(name, originInput);
    yield* writeConfigEffect(result.config, home);
    return result.remote;
  },
  (effect, _name, _origin, home) => withConfigurationWriter(home, effect),
);
export const defaultRegistryRemoteEffect = Effect.fn("Registry.defaultRemote")(
  function* (name: string, home?: string) {
    const result = yield* (yield* readAccounts(home)).setDefault(name);
    yield* writeConfigEffect(result.config, home);
    return result.remote;
  },
  (effect, _name, home) => withConfigurationWriter(home, effect),
);
export const removeRegistryRemoteEffect = Effect.fn("Registry.removeRemote")(
  function* (name: string, home?: string) {
    const result = yield* (yield* readAccounts(home)).removeAlias(name);
    yield* writeConfigEffect(result.config, home);
    return result.remote;
  },
  (effect, _name, home) => withConfigurationWriter(home, effect),
);

/** Select a Registry without letting a device-local name enter durable Source state. */
export const resolveRegistryLocatorEffect = Effect.fn("Registry.resolveLocator")(function* (
  input: string,
  options: { readonly registry?: string; readonly home?: string } = {},
) {
  const match = input.match(/^skit:\/\/([^/]+)\/(.+)$/);
  if (match && options.registry) return yield* new RegistrySelectionConflict({ locator: input });
  const accounts = yield* readAccounts(options.home);
  if (match) {
    const origin = `https://${match[1]}`;
    return { input, origin, token: accounts.stored(origin)?.token };
  }
  if (!options.registry) return { input };
  if (!input.startsWith("skit:"))
    return yield* new RegistrySelectionRequiresRegistrySource({ source: input });
  const origin = yield* accounts.select(options.registry, "explicit");
  return { input, origin, token: origin ? accounts.stored(origin)?.token : undefined };
});

/** Resolve a device-local login selector before asking the user for credentials. */
export const resolveLoginTargetEffect = Effect.fn("Auth.resolveLoginTarget")(function* (
  selectedRegistry?: string,
  home?: string,
) {
  return yield* (yield* readAccounts(home)).loginTarget(selectedRegistry);
});

export function resolveAuthForOriginEffect(
  originInput: string,
  home?: string,
): Effect.Effect<
  ResolvedAuth,
  RegistryOriginInvalid | CredentialsUnusable | Config.ConfigError,
  FileSystem.FileSystem | SkitConfiguration | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const origin = yield* parseOrigin(originInput);
    const environment = yield* environmentCredential(yield* accountEnvironment, origin);
    if (environment) return environment;
    return yield* (yield* readAccounts(home)).credential(origin);
  });
}

/** Check the saved bearer before collecting new credentials. No Library data is changed. */
export const reuseLoginEffect = Effect.fn("Auth.reuseLogin")(function* (input: {
  origin: string;
  scopes: readonly string[];
  alias?: string;
  home?: string;
}) {
  const origin = yield* parseOrigin(input.origin);
  if (yield* environmentCredential(yield* accountEnvironment, origin)) return undefined;
  const accounts = yield* readAccounts(input.home);
  const auth = yield* accounts.credential(origin);
  if (!auth.token || !auth.scopes || !input.scopes.every((scope) => auth.scopes?.includes(scope)))
    return undefined;
  if (auth.expiresAt) {
    const expiry = Date.parse(auth.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= (yield* Clock.currentTimeMillis)) return undefined;
  }
  if (input.alias && !accounts.hasAlias(input.alias, input.origin)) return undefined;
  const http = yield* (yield* RegistryHttp).client;
  const response = yield* http
    .execute(
      HttpClientRequest.get(new URL("/api/library/portable", input.origin).href).pipe(
        HttpClientRequest.bearerToken(auth.token),
      ),
    )
    .pipe(Effect.mapError((cause) => new RegistryUnreachable({ origin: input.origin, cause })));
  if (response.status === 401) return undefined;
  if (response.status !== 200) {
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ApiErrorBody)),
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
  const alias = input.alias ?? accounts.aliasesOf(input.origin)[0];
  return {
    origin: input.origin,
    tokenPrefix: auth.tokenPrefix ?? "",
    scopes: auth.scopes,
    ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
    ...(alias ? { alias } : {}),
    ...(accounts.defaultRegistry ? { defaultRegistry: accounts.defaultRegistry } : {}),
    alreadyAuthenticated: true,
    credentialPath: yield* authPath(input.home),
  };
});

export const authStatusCommand = Effect.fn("CLI.authStatus")(function* (
  home?: string,
  selectedRegistry?: string,
) {
  const accounts = yield* readAccounts(home);
  return yield* accounts.status(selectedRegistry, yield* Clock.currentTimeMillis);
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
  const detail = yield* Schema.decodeUnknownEffect(ApiErrorBody)(body).pipe(
    Effect.map(({ error }) => error),
    Effect.orElseSucceed(() => "unknown_error"),
  );
  return yield* new SignInFailed({
    message: `${context} failed (${response.status}): ${detail}`,
  });
});

/** A Registry's transport and discovery document, checked to offer every requested scope. */
const openExchange = Effect.fn("Auth.openExchange")(function* (
  origin: string,
  scopes: readonly AuthScope[],
) {
  const http = yield* (yield* RegistryHttp).client;
  const send = (
    url: URL,
    init: {
      readonly method?: "GET" | "POST" | "PUT" | "DELETE";
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    } = {},
  ): Effect.Effect<HttpClientResponse, RegistryUnreachable> => {
    let request = HttpClientRequest.make(init.method ?? "GET")(url, { headers: init.headers });
    if (init.body !== undefined)
      request = HttpClientRequest.bodyText(request, init.body, "application/json");
    return http
      .execute(request)
      .pipe(Effect.mapError((error) => new RegistryUnreachable({ origin, cause: error.cause })));
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
  const unsupportedScopes = scopes.filter((scope) => !discovery.scopes.includes(scope));
  if (unsupportedScopes.length > 0)
    return yield* new SignInFailed({
      message: `Registry does not support requested scopes: ${unsupportedScopes.join(", ")}`,
    });
  // A CLI can self-assert Origin; this preserves Better Auth compatibility rather than acting as
  // a security boundary. Browser requests still receive real origin enforcement.
  const json = { "content-type": "application/json", origin };
  return { http, send, discovery, json };
});
type Exchange = Effect.Success<ReturnType<typeof openExchange>>;

/** The only device-authorization client the Registry accepts. */
const CLI_DEVICE_CLIENT_ID = "skit-cli";
const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});
const DeviceTokenResponse = Schema.Struct({ access_token: Schema.String });
const DeviceTokenError = Schema.Struct({ error: Schema.String });

/**
 * A browser login waiting for the user to approve its code. A run that cannot wait for the user
 * saves it, and the next `skit auth login` for the same Registry polls with it.
 */
export const PendingDeviceLogin = Schema.Struct({
  origin: Schema.String,
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  interval: Schema.Number,
  expiresAt: Schema.String,
});
export type PendingDeviceLogin = typeof PendingDeviceLogin.Type;

const requestDeviceCode = Effect.fn("Auth.requestDeviceCode")(function* (
  exchange: Exchange,
  origin: string,
) {
  const { discovery, send, json } = exchange;
  if (discovery.deviceAuthorization === undefined || discovery.deviceToken === undefined)
    return yield* new DeviceLoginUnavailable({ origin });
  const started = yield* send(new URL(discovery.deviceAuthorization, origin), {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_id: CLI_DEVICE_CLIENT_ID }),
  });
  if (!ok(started)) return yield* rejected(started, "Device authorization");
  const code = yield* started.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DeviceCodeResponse)),
    Effect.mapError(
      (error) => new SignInFailed({ message: `Device authorization is invalid: ${error.message}` }),
    ),
  );
  return {
    origin,
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    interval: code.interval,
    expiresAt: new Date((yield* Clock.currentTimeMillis) + code.expires_in * 1_000).toISOString(),
  } satisfies PendingDeviceLogin;
});

/** Where a started browser login waits for its next run: beside auth.json, as private. */
const pendingLoginPath = (home?: string) =>
  Effect.map(authPath(home), (path) => join(dirname(path), "login-pending.json"));

/** The browser login waiting on `origin`, unless none was started, it expired, or it is unreadable. */
export const readPendingLogin = Effect.fn("Auth.readPendingLogin")(function* (
  origin: string,
  home?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pending = yield* fs
    .readFileString(yield* pendingLoginPath(home))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PendingDeviceLogin))),
      Effect.option,
    );
  if (Option.isNone(pending) || pending.value.origin !== origin) return undefined;
  return Date.parse(pending.value.expiresAt) > (yield* Clock.currentTimeMillis)
    ? pending.value
    : undefined;
});

export const savePendingLogin = Effect.fn("Auth.savePendingLogin")(function* (
  pending: PendingDeviceLogin,
  home?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* pendingLoginPath(home);
  yield* fs.makeDirectory(dirname(path), { recursive: true });
  yield* fs.writeFileString(path, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  yield* fs.chmod(path, 0o600);
});

export const clearPendingLogin = Effect.fn("Auth.clearPendingLogin")(function* (home?: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* pendingLoginPath(home), { force: true });
});

/** Start a browser login without waiting for it, for a caller that cannot wait for the user. */
export const startDeviceLoginEffect = Effect.fn("Auth.startDeviceLogin")(function* (input: {
  origin: string;
  scopes: readonly AuthScope[];
}) {
  const origin = yield* validateAuthenticationOrigin(input.origin);
  return yield* requestDeviceCode(yield* openExchange(origin, input.scopes), origin);
});

/** Poll until the user approves `pending`, returning the approved session's token. */
const awaitDeviceApproval = Effect.fn("Auth.awaitDeviceApproval")(function* (
  exchange: Exchange,
  pending: PendingDeviceLogin,
) {
  const { discovery, send, json } = exchange;
  if (discovery.deviceToken === undefined)
    return yield* new DeviceLoginUnavailable({ origin: pending.origin });
  const deadline = Date.parse(pending.expiresAt);
  // RFC 8628 §3.5: wait the interval between polls, and five seconds longer after slow_down.
  let interval = pending.interval;
  while (true) {
    if ((yield* Clock.currentTimeMillis) >= deadline)
      return yield* new DeviceLoginEnded({ reason: "expired" });
    yield* Effect.sleep(Duration.seconds(interval));
    const polled = yield* send(new URL(discovery.deviceToken, pending.origin), {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode,
        client_id: CLI_DEVICE_CLIENT_ID,
      }),
    });
    if (ok(polled)) {
      const granted = yield* polled.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DeviceTokenResponse)),
        Effect.mapError(
          (error) =>
            new SignInFailed({ message: `Device authorization is invalid: ${error.message}` }),
        ),
      );
      return granted.access_token;
    }
    const error = yield* polled.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DeviceTokenError)),
      Effect.map((body) => body.error),
      Effect.orElseSucceed(() => undefined),
    );
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") return yield* new DeviceLoginEnded({ reason: "denied" });
    if (error === "expired_token") return yield* new DeviceLoginEnded({ reason: "expired" });
    return yield* rejected(polled, "Device authorization");
  }
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
export const loginEffect = Effect.fn("Auth.login")(
  function* (input: {
    origin: string;
    /** Sign in with these, or leave both out to have the user approve the login in a browser. */
    email?: string;
    password?: string;
    /** A browser login an earlier run started, to wait for instead of starting another. */
    pending?: PendingDeviceLogin;
    /** Show the user the code to approve; called once, before polling starts. */
    onDeviceCode?: (pending: PendingDeviceLogin) => Effect.Effect<void>;
    scopes: AuthScope[];
    alias?: string;
    home?: string;
  }) {
    const origin = yield* validateAuthenticationOrigin(input.origin);
    const accounts = yield* readAccounts(input.home);
    yield* accounts.checkLoginAlias(origin, input.alias);
    const existing = accounts.stored(origin);
    const exchange = yield* openExchange(origin, input.scopes);
    const { http, send, json } = exchange;
    /** The temporary session's credential, as request headers. */
    const session: Readonly<Record<string, string>> = yield* Effect.gen(function* () {
      if (input.email !== undefined && input.password !== undefined) {
        const signIn = yield* send(new URL("/api/auth/sign-in/email", origin), {
          method: "POST",
          headers: json,
          body: JSON.stringify({ email: input.email, password: input.password }),
        });
        if (!ok(signIn)) return yield* rejected(signIn, "Sign in");
        const cookie = Cookies.toCookieHeader(signIn.cookies);
        if (!cookie)
          return yield* new SignInFailed({ message: "Sign in did not establish a session" });
        return { ...json, cookie };
      }
      const pending = input.pending ?? (yield* requestDeviceCode(exchange, origin));
      if (input.onDeviceCode) yield* input.onDeviceCode(pending);
      const token = yield* awaitDeviceApproval(exchange, pending);
      return { ...json, authorization: `Bearer ${token}` };
    });
    const sessionClient = yield* HttpApiClient.makeWith(ConsumerAuthenticatedApi, {
      httpClient: http,
      baseUrl: origin,
    }).pipe(Effect.provide(sessionApiMiddleware(session)));
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
            ? new RegistryUnreachable({ origin, cause: error.cause })
            : new SignInFailed({ message: "Credential cleanup request could not be encoded" }),
        ),
      );

    const signOutRequest = () =>
      send(new URL("/api/auth/sign-out", origin), {
        method: "POST",
        headers: session,
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

    const signedIn = accounts.signedIn(origin, created, input.alias);
    const stored = yield* Effect.result(writeConfigEffect(signedIn.config, input.home));
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
      ...(signedIn.alias ? { alias: signedIn.alias } : {}),
      ...(signedIn.defaultRegistry ? { defaultRegistry: signedIn.defaultRegistry } : {}),
      alreadyAuthenticated: false,
      credentialPath: yield* authPath(input.home),
    };
  },
  (effect, input) => withConfigurationWriter(input.home, effect),
);

/**
 * Revoke the stored credential and forget it locally.
 *
 * The local forget happens whether or not the Registry accepted the revocation: a credential the
 * server already rejected or lost is still not one this machine should keep offering.
 */
export const logoutEffect = Effect.fn("Auth.logout")(
  function* (home?: string, selectedOrigin?: string) {
    const accounts = yield* readAccounts(home);
    const origin = yield* accounts.select(selectedOrigin, "logout");
    const credential = origin ? accounts.stored(origin) : undefined;
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
            ? new RegistryUnreachable({ origin, cause: error.cause })
            : new SignOutRejected({ message: "Logout request could not be encoded" }),
        ),
      );
    const ok = response.status >= 200 && response.status < 300;
    if (!ok && ![401, 404].includes(response.status)) {
      const body = yield* response.json.pipe(
        Effect.catchTag("HttpClientError", () => Effect.succeed({})),
      );
      if (response.status === 429) return yield* new TooManyAuthAttempts();
      const detail = yield* Schema.decodeUnknownEffect(ApiErrorBody)(body).pipe(
        Effect.map(({ error }) => error),
        Effect.orElseSucceed(() => "unknown_error"),
      );
      return yield* new SignOutRejected({
        message: `Logout failed (${response.status}): ${detail}`,
      });
    }
    yield* writeConfigEffect(accounts.signedOut(origin), home);
    return { origin, revoked: ok };
  },
  (effect, home, _selectedOrigin) => withConfigurationWriter(home, effect),
);

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
