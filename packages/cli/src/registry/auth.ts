import { configurationForHome, SkitConfiguration } from "@smolai/skit-core/platform";
import { isErrno } from "@smolai/skit-core/shared";
import * as HomeLock from "@smolai/skit-core/platform/home-lock";
import { serverDiscoverySchema } from "@smolai/skit-core/api";
import { Clock, Config, Effect, FileSystem, Option, Redacted, Result, Schema } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ChildProcessSpawner } from "effect/process";
import type { HttpClientResponse } from "effect/http/HttpClientResponse";
import { hostname } from "node:os";
import { dirname } from "node:path";

import {
  CredentialsUnusable,
  NoStoredCredentials,
  RegistryOriginInvalid,
  RegistrySelectionConflict,
  RegistrySelectionRequiresRegistrySource,
  RegistryUnreachable,
  SignInFailed,
  SignInRejected,
  SignOutRejected,
  TooManyAuthAttempts,
} from "./failures.js";
import {
  CredentialRotationWarning,
  type AuthCleanupFailure,
  type AuthOperation,
} from "./auth-failures.js";
import { isRegistryTransportError, RegistryHttp } from "./registry-http.js";
import {
  osTokenStorage,
  readStoredToken,
  removeStoredToken,
  writeStoredToken,
} from "./credential-store.js";

export const withConfigurationWriter = <A, E, R>(
  home: string | undefined,
  program: Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(configurationForHome(home), (paths) =>
    HomeLock.withLock(paths.skitHome, Effect.scoped(program)).pipe(
      Effect.provideService(SkitConfiguration, paths),
    ),
  );
import {
  ApiErrorBody,
  ConsumerAuthenticatedApi,
  RateLimitedResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/api";
import {
  authenticatedApiMiddleware,
  classifyRegistryApiFailure,
  markRegistryResponseDecoding,
  registryApiFailure,
  sessionApiMiddleware,
} from "./api-client.js";

/** Every Registry status this module treats as success. */
const ok = (response: HttpClientResponse) => response.status >= 200 && response.status < 300;

const AUTH_SCOPES = ["library:sync", "authoring:write", "publication:write"] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

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
  return new RegistryAccounts(yield* readConfig(home), yield* accountEnvironment);
});

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
        if (isErrno(error, "ENOENT")) return Effect.undefined;
        return Effect.fail(
          new CredentialsUnusable({
            path,
            reason: isErrno(error, "EACCES", "EPERM") ? "unreadable" : "invalid",
            failure: error,
          }),
        );
      }),
    );
    if (text === undefined) return { schemaVersion: 1 as const, registryAliases: {}, servers: {} };
    // This configuration reader deliberately classifies malformed values as unusable.
    return yield* decodeAuthConfig(text).pipe(
      Effect.mapError((failure) => new CredentialsUnusable({ path, reason: "invalid", failure })),
    );
  });
}

/**
 * The account configuration with each stored token in place, wherever it is kept. A token the OS
 * store cannot supply is left absent; requests then go unauthenticated and ask the user to log in
 * again, rather than every command failing on a locked keychain.
 */
export function readConfig(home?: string) {
  return Effect.gen(function* () {
    const path = yield* authPath(home);
    const config = yield* readAuthDocument(home);
    const servers: Record<string, StoredCredential> = {};
    for (const [origin, credential] of Object.entries(config.servers)) {
      const token =
        credential.token === undefined && credential.tokenStorage !== undefined
          ? yield* readStoredToken(
              credential.tokenStorage,
              path,
              origin,
              credential.tokenStorageKey,
            )
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
const writeConfig = Effect.fn("Auth.writeConfig")(function* (config: AuthConfig, home?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* authPath(home);
  const previous = yield* Effect.option(readAuthDocument(home));
  const storage = osTokenStorage();
  const servers: Record<string, StoredCredential> = {};
  // Replacement items never overwrite the item the current auth document still names.
  const staged: Array<{
    storage: NonNullable<StoredCredential["tokenStorage"]>;
    origin: string;
    key: string;
  }> = [];
  let published = false;
  yield* Effect.addFinalizer(() =>
    Effect.forEach(staged, (item) =>
      published &&
      servers[item.origin]?.tokenStorage === item.storage &&
      servers[item.origin]?.tokenStorageKey === item.key
        ? Effect.void
        : removeStoredToken(item.storage, path, item.origin, item.key),
    ),
  );
  for (const [origin, credential] of Object.entries(config.servers)) {
    // A token this run could not read stays wherever it already is.
    if (credential.token === undefined) {
      servers[origin] = credential;
      continue;
    }
    const {
      token,
      tokenStorage: _previous,
      tokenStorageKey: _previousKey,
      ...metadata
    } = credential;
    const key = credential.tokenId;
    const prior = Option.isSome(previous) ? previous.value.servers[origin] : undefined;
    if (storage !== undefined && (prior?.tokenStorage !== storage || prior.tokenStorageKey !== key))
      staged.push({ storage, origin, key });
    servers[origin] =
      storage !== undefined && (yield* writeStoredToken(storage, path, origin, token, key))
        ? { ...metadata, tokenStorage: storage, tokenStorageKey: key }
        : { ...metadata, token };
  }
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  yield* fs.writeFileString(temporary, `${JSON.stringify({ ...config, servers }, null, 2)}\n`, {
    mode: 0o600,
  });
  // The write mode is subject to umask; credentials get the permission set explicitly.
  yield* fs.chmod(temporary, 0o600);
  yield* fs.rename(temporary, path).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        published = true;
      }),
    ),
    Effect.uninterruptible,
  );
  if (Option.isNone(previous)) return;
  for (const [origin, credential] of Object.entries(previous.value.servers))
    if (
      credential.tokenStorage !== undefined &&
      (servers[origin]?.tokenStorage !== credential.tokenStorage ||
        servers[origin]?.tokenStorageKey !== credential.tokenStorageKey)
    )
      yield* removeStoredToken(credential.tokenStorage, path, origin, credential.tokenStorageKey);
}, Effect.scoped);

const resolveAuth = Effect.fnUntraced(function* (
  home?: string,
  registry?: string,
  durableOrigin?: string,
  command?: string,
) {
  const accounts = yield* readAccounts(home);
  return yield* accounts.credential(
    yield* accounts.select(registry, "ambient", { durableOrigin, command }),
  );
});

export const listRegistryRemotes = Effect.fn("Registry.listRemotes")(function* (home?: string) {
  return (yield* readAccounts(home)).remotes();
});

export const addRegistryRemote = Effect.fn("Registry.addRemote")(
  function* (name: string, originInput: string, home?: string) {
    const result = yield* (yield* readAccounts(home)).addAlias(name, originInput);
    yield* writeConfig(result.config, home);
    return result.remote;
  },
  (effect, _name, _origin, home) => withConfigurationWriter(home, effect),
);
export const defaultRegistryRemote = Effect.fn("Registry.defaultRemote")(
  function* (name: string, home?: string) {
    const result = yield* (yield* readAccounts(home)).setDefault(name);
    yield* writeConfig(result.config, home);
    return result.remote;
  },
  (effect, _name, home) => withConfigurationWriter(home, effect),
);
export const removeRegistryRemote = Effect.fn("Registry.removeRemote")(
  function* (name: string, home?: string) {
    const result = yield* (yield* readAccounts(home)).removeAlias(name);
    yield* writeConfig(result.config, home);
    return result.remote;
  },
  (effect, _name, home) => withConfigurationWriter(home, effect),
);

/** Select a Registry without letting a device-local name enter durable Source state. */
export const resolveRegistryLocator = Effect.fn("Registry.resolveLocator")(function* (
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
export const resolveLoginTarget = Effect.fn("Auth.resolveLoginTarget")(function* (
  selectedRegistry?: string,
  home?: string,
) {
  return yield* (yield* readAccounts(home)).loginTarget(selectedRegistry);
});

function resolveAuthForOrigin(
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
export const reuseLogin = Effect.fn("Auth.reuseLogin")(function* (input: {
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
        (failure) =>
          new SignInFailed({
            origin,
            reason: {
              _tag: "RequestFailed",
              operation: "credential-check",
              status: response.status,
              failure,
            },
          }),
      ),
    );
    if (
      !(
        (response.status === 404 && body.error === "library_not_found") ||
        (response.status === 403 && body.error === "insufficient_scope")
      )
    )
      return yield* new SignInFailed({
        origin,
        reason: {
          _tag: "RequestFailed",
          operation: "credential-check",
          status: response.status,
          registryCode: body.error,
        },
      });
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

export const registryStatus = Effect.fn("Registry.status")(function* (
  home?: string,
  selectedRegistry?: string,
) {
  const accounts = yield* readAccounts(home);
  return yield* accounts.status(selectedRegistry, yield* Clock.currentTimeMillis);
});

/** A rejected authentication request, retaining only statuses and codes actually received. */
export const rejected = Effect.fn("Auth.rejected")(function* (
  response: HttpClientResponse,
  origin: string,
  operation: AuthOperation,
) {
  const body = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ApiErrorBody)),
    Effect.result,
  );
  if (response.status === 401) return yield* new SignInRejected({ operation });
  if (response.status === 429) return yield* new TooManyAuthAttempts();
  return yield* new SignInFailed({
    origin,
    reason: {
      _tag: "RequestFailed",
      operation,
      status: response.status,
      ...(Result.isSuccess(body)
        ? { registryCode: body.success.error }
        : { failure: body.failure }),
    },
  });
});

/** A Registry's transport and discovery document, checked to offer every requested scope. */
export const openExchange = Effect.fn("Auth.openExchange")(function* (
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
      origin,
      reason: { _tag: "RequestFailed", operation: "discovery", status: discoveryResponse.status },
    });
  const discovery = yield* discoveryResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(serverDiscoverySchema)),
    Effect.mapError(
      (failure) =>
        new SignInFailed({
          origin,
          reason: {
            _tag: "ResponseInvalid",
            operation: "discovery",
            status: discoveryResponse.status,
            failure,
          },
        }),
    ),
  );
  const unsupportedScopes = scopes.filter((scope) => !discovery.scopes.includes(scope));
  if (unsupportedScopes.length > 0)
    return yield* new SignInFailed({
      origin,
      reason: { _tag: "UnsupportedScopes", scopes: unsupportedScopes },
    });
  // A CLI can self-assert Origin; this preserves Better Auth compatibility rather than acting as
  // a security boundary. Browser requests still receive real origin enforcement.
  const json = { "content-type": "application/json", origin };
  return { http, send, discovery, json };
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
    /** Sign in with these. */
    email?: string;
    password?: string;
    /** Or the session a browser login was approved with (see `awaitDeviceApproval`). */
    approvedSessionToken?: string;
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
        if (!ok(signIn)) return yield* rejected(signIn, origin, "sign-in");
        const cookie = Cookies.toCookieHeader(signIn.cookies);
        if (!cookie) return yield* new SignInFailed({ origin, reason: { _tag: "SessionMissing" } });
        return { ...json, cookie };
      }
      if (input.approvedSessionToken === undefined)
        return yield* new SignInFailed({ origin, reason: { _tag: "MethodMissing" } });
      return { ...json, authorization: `Bearer ${input.approvedSessionToken}` };
    });
    // This client makes only the credential-creation request. Keep the received status even
    // when its body fails decoding; an API error code alone cannot prove the HTTP status.
    let credentialResponseStatus: number | undefined;
    const sessionClient = yield* HttpApiClient.makeWith(ConsumerAuthenticatedApi, {
      transformResponse: markRegistryResponseDecoding,
      httpClient: HttpClient.tap(http, (response) =>
        Effect.sync(() => {
          credentialResponseStatus = response.status;
        }),
      ),
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
      );

    const credentialCleanup = Effect.fn("Auth.cleanupCredential")(function* (
      credential: StoredCredential,
    ) {
      const response = yield* Effect.result(revoke(credential));
      if (Result.isFailure(response))
        return { _tag: "RequestFailed", failure: response.failure } satisfies AuthCleanupFailure;
      if (ok(response.success) || [401, 404].includes(response.success.status)) return undefined;
      return {
        _tag: "ResponseRejected",
        status: response.success.status,
      } satisfies AuthCleanupFailure;
    });
    const signOutRequest = () =>
      http.execute(
        HttpClientRequest.make("POST")(new URL("/api/auth/sign-out", origin), {
          headers: session,
        }).pipe(HttpClientRequest.bodyText("{}", "application/json")),
      );
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
            Effect.mapError((error) => {
              const classified = classifyRegistryApiFailure(error, [201]);
              if (Schema.is(UnauthorizedResponse)(error))
                return new SignInRejected({ operation: "credential-create" });
              if (Schema.is(RateLimitedResponse)(error)) return new TooManyAuthAttempts();
              if (classified.kind === "response_decode")
                return new SignInFailed({
                  origin,
                  reason: {
                    _tag: "ResponseInvalid",
                    operation: "credential-create",
                    ...(credentialResponseStatus === undefined
                      ? {}
                      : { status: credentialResponseStatus }),
                    failure: classified.failure,
                  },
                });
              if (classified.kind === "request_encoding")
                return new SignInFailed({
                  origin,
                  reason: {
                    _tag: "RequestInvalid",
                    operation: "credential-create",
                    failure: classified.failure,
                  },
                });
              const facts = registryApiFailure(error);
              return new SignInFailed({
                origin,
                reason: {
                  _tag: "RequestFailed",
                  operation: "credential-create",
                  ...(credentialResponseStatus === undefined
                    ? {}
                    : { status: credentialResponseStatus }),
                  ...(facts.code === undefined ? {} : { registryCode: facts.code }),
                  failure: error,
                },
              });
            }),
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
    const signOut = yield* Effect.result(signOutRequest());
    if (Result.isFailure(signOut) || !ok(signOut.success)) {
      const cleanup = created ? yield* credentialCleanup(created) : undefined;
      unsaved = undefined;
      const original = Result.isFailure(creation) ? { original: creation.failure } : {};
      const sessionCleanup: AuthCleanupFailure = yield* Effect.gen(function* () {
        if (Result.isFailure(signOut))
          return { _tag: "RequestFailed", failure: signOut.failure } as const;
        // As before, do not read the sign-out body when credential cleanup also failed.
        if (cleanup) return { _tag: "ResponseRejected", status: signOut.success.status } as const;
        const detail = yield* Effect.result(signOut.success.text);
        return {
          _tag: "ResponseRejected",
          status: signOut.success.status,
          ...(Result.isSuccess(detail)
            ? { body: detail.success.slice(0, 500) }
            : { failure: detail.failure }),
        } as const;
      });
      return yield* new SignInFailed({
        origin,
        reason: {
          _tag: "SessionEndFailed",
          cleanup: sessionCleanup,
          ...original,
          ...(created && cleanup
            ? {
                credential: {
                  tokenId: created.tokenId,
                  tokenPrefix: created.tokenPrefix,
                  cleanup,
                },
              }
            : {}),
        },
      });
    }
    if (Result.isFailure(creation)) return yield* creation.failure;
    if (!created) return yield* new SignInFailed({ origin, reason: { _tag: "CredentialMissing" } });

    const signedIn = accounts.signedIn(origin, created, input.alias);
    const stored = yield* Effect.result(writeConfig(signedIn.config, input.home));
    if (Result.isFailure(stored)) {
      const cleanup = yield* credentialCleanup(created);
      unsaved = undefined;
      if (cleanup)
        return yield* new SignInFailed({
          origin,
          reason: {
            _tag: "StorageCleanupFailed",
            tokenId: created.tokenId,
            tokenPrefix: created.tokenPrefix,
            cleanup,
            original: stored.failure,
          },
        });
      return yield* stored.failure;
    }
    // Stored: an interrupt after this point must not revoke the credential the caller now has.
    unsaved = undefined;

    let warning: typeof CredentialRotationWarning.Type | undefined;
    if (existing) {
      const cleanup = yield* credentialCleanup(existing);
      if (cleanup)
        warning = {
          _tag: "PreviousCredentialNotRevoked",
          tokenId: existing.tokenId,
          tokenPrefix: existing.tokenPrefix,
          cleanup,
        };
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
 * Forget only after successful revocation or an already absent/rejected credential (401/404).
 * Other failures keep the saved credential so a later logout can retry its revocation.
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
            : new SignOutRejected({ origin, reason: { _tag: "RequestInvalid", failure: error } }),
        ),
      );
    const ok = response.status >= 200 && response.status < 300;
    if (!ok && ![401, 404].includes(response.status)) {
      const body = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ApiErrorBody)),
        Effect.result,
      );
      if (response.status === 429) return yield* new TooManyAuthAttempts();
      return yield* new SignOutRejected({
        origin,
        reason: {
          _tag: "ResponseRejected",
          status: response.status,
          ...(Result.isSuccess(body)
            ? { registryCode: body.success.error }
            : { failure: body.failure }),
        },
      });
    }
    yield* writeConfig(accounts.signedOut(origin), home);
    return { origin, revoked: ok };
  },
  (effect, home, _selectedOrigin) => withConfigurationWriter(home, effect),
);

/** A concrete origin never borrows a different Registry's ambient credentials. */
export const registryCredentials = Effect.fn("Registry.credentials")(function* (
  options: {
    readonly home?: string;
    readonly registry?: string;
    readonly origin?: string;
    readonly command?: string;
  } = {},
) {
  return options.origin === undefined
    ? yield* resolveAuth(options.home, options.registry, undefined, options.command)
    : yield* resolveAuthForOrigin(options.origin, options.home);
});
