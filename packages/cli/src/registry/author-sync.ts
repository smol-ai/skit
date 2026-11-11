import { AuthorRequestFailed, AuthorRequestTimedOut } from "./request-failures.js";
import { Registry } from "./index.js";
import { listAuthorInventory, deletePrivateAuthorSkit } from "./authoring.js";
import { publishRelease } from "./publication.js";
import {
  AuthoringAuthenticatedApi,
  CurrentMovedResponse,
  SkitExistsResponse,
  SkitNotFoundResponse,
} from "@smolai/skit-core/api";
import {
  type AuthorRemoteHome,
  type AuthorVisibility,
  Moved,
  type SyncRemote,
} from "@smolai/skit-core/author";
import { Effect, Option, Result, Schema, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  classifyRegistryApiFailure,
  registryContractFailure,
  markRegistryResponseDecoding,
  registryApiFailure,
} from "./api-client.js";
import { RegistryHttp } from "./registry-http.js";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  DestinationExistsWithoutHistory,
  PrincipalNotAuthorized,
  RegistryUnreachable,
  RemoteSkitUnavailable,
} from "./failures.js";

/** A SKIT request the Registry answered, with its own words for why it refused. */

/** One scoped SKIT protocol session. Mutations never retry; recovery belongs to the workspace. */
export const authorSyncApi = Effect.fn("Registry.authorSyncApi")(function* (input: {
  remote: AuthorRemoteHome;
  locator: string;
  token?: string;
}) {
  const { remote, locator } = input;
  const owner = remote.namespace;
  const slug = remote.skit;
  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    transformResponse: markRegistryResponseDecoding,
    httpClient: transport,
    baseUrl: remote.origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(input.token)));
  const failure =
    (operation: AuthorRequestFailed["operation"], successStatus: number) => (error: unknown) => {
      if (Schema.is(AuthorRequestTimedOut)(error)) return error;
      const context = {
        current: "skit current",
        revision: "skit revision",
        ancestors: "skit history",
        post: "skit revision",
        move: "skit move",
        create: "skit create",
      }[operation];
      const classified = classifyRegistryApiFailure(error, [successStatus]);
      if (classified.kind === "transport")
        return new RegistryUnreachable({
          origin: remote.origin,
          cause: classified.error.cause,
        });
      if (classified.kind === "unauthorized")
        return new AuthenticationRequired({
          scopes: "library:sync,authoring:write",
        });
      if (classified.kind === "insufficient_scope")
        return new CredentialLacksScope({
          scope: "authoring:write",
          scopes: "library:sync,authoring:write",
        });
      if (classified.kind === "forbidden")
        return new PrincipalNotAuthorized({
          action: "author this Namespace or SKIT",
        });
      if (Schema.is(SkitNotFoundResponse)(error))
        return new RemoteSkitUnavailable({ identity: locator });
      if (classified.kind === "response_decode" || classified.kind === "request_encoding")
        return registryContractFailure(
          `${context} ${classified.kind === "request_encoding" ? "request" : "response"}`,
          classified.failure,
        );
      const response = registryApiFailure(error);
      return new AuthorRequestFailed({
        origin: remote.origin,
        operation,
        ...(response.status === undefined ? {} : { status: response.status }),
        ...(response.code === undefined ? {} : { registryCode: response.code }),
        failure: error,
      });
    };
  // Bound the request and body decoding together. Mutations never retry here.
  const withinDeadline = (operation: AuthorRequestFailed["operation"]) =>
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new AuthorRequestTimedOut({ origin: remote.origin, operation, timeoutMs: 30_000 }),
        ),
    });
  const params = { owner, slug };
  // This SKIT on the Registry, for this command only. The transport never retries, so no retry
  // delay waits while the lease is held.
  const registry: SyncRemote<ReturnType<ReturnType<typeof failure>>> = {
    current: client.skits.current({ params }).pipe(
      withinDeadline("current"),
      Effect.map((skit) => skit.current),
      Effect.mapError(failure("current", 200)),
    ),
    revision: (id) =>
      client.skits.revision({ params: { ...params, id } }).pipe(
        withinDeadline("revision"),
        Effect.map(({ revision, tree }) => ({ revision, tree })),
        Effect.mapError(failure("revision", 200)),
      ),
    ancestors: (id) =>
      Stream.paginate(Option.none<string>(), (cursor) =>
        client.skits
          .ancestors({
            params,
            query: Option.match(cursor, {
              onNone: () => ({ ancestors: id }),
              onSome: (next) => ({ ancestors: id, cursor: next }),
            }),
          })
          .pipe(
            withinDeadline("ancestors"),
            Effect.map(
              (page) =>
                [
                  page.revisions.map(({ id, revision }) => ({
                    id,
                    revision,
                  })),
                  Option.map(Option.fromNullishOr(page.next_cursor), Option.some),
                ] as const,
            ),
            Effect.mapError(failure("ancestors", 200)),
          ),
      ),
    post: (id, revision, tree) =>
      client.skits
        .post({ params, payload: { id, revision, tree } })
        .pipe(withinDeadline("post"), Effect.asVoid, Effect.mapError(failure("post", 200))),
    move: (expected, id) =>
      client.skits.move({ params, payload: { expected, id } }).pipe(
        withinDeadline("move"),
        Effect.asVoid,
        Effect.mapError((error) =>
          Schema.is(CurrentMovedResponse)(error)
            ? new Moved({ current: error.current })
            : failure("move", 200)(error),
        ),
      ),
  };
  return {
    remote: registry,
    requireAvailable: Effect.gen(function* () {
      const existing = yield* client.skits
        .current({ params })
        .pipe(withinDeadline("current"), Effect.result);
      if (Result.isSuccess(existing))
        return yield* new DestinationExistsWithoutHistory({
          identity: locator,
        });
      if (!Schema.is(SkitNotFoundResponse)(existing.failure))
        return yield* failure("current", 200)(existing.failure);
    }),
    create: (visibility: AuthorVisibility, requestId: string) =>
      client.skits
        .create({
          payload: { owner, slug, visibility, request_id: requestId },
        })
        .pipe(
          withinDeadline("create"),
          Effect.mapError((error) =>
            Schema.is(SkitExistsResponse)(error)
              ? new DestinationExistsWithoutHistory({ identity: locator })
              : failure("create", 201)(error),
          ),
        ),
  };
});

/** Transport composition for Author; credentials are selected only for the named Registry. */
export const authorRegistry = (home?: string, registry?: string) => ({
  list: Effect.gen(function* () {
    return yield* listAuthorInventory(yield* Registry.credentials({ home, registry }));
  }).pipe(Effect.withSpan("Registry.listAuthor")),
  delete: Effect.fn("Registry.deleteAuthor")(function* (
    remote: AuthorRemoteHome,
    options: { readonly dryRun?: boolean },
  ) {
    const credentials = yield* Registry.credentials({
      origin: remote.origin,
      home,
    });
    return yield* deletePrivateAuthorSkit(remote, {
      token: credentials.token,
      ...options,
    });
  }, Effect.scoped),
  publish: Effect.fn("Registry.publishAuthor")(function* (remote: AuthorRemoteHome) {
    const credentials = yield* Registry.credentials({
      origin: remote.origin,
      home,
    });
    if (!credentials.token)
      return yield* new AuthenticationRequired({
        origin: remote.origin,
        scopes: "library:sync,authoring:write,publication:write",
      });
    const token = credentials.token;
    // The client is built here, in the adapter's own context, so the upload needs nothing else.
    const http = yield* (yield* RegistryHttp).client;
    return (input: {
      readonly root: string;
      readonly version: string;
      readonly revision?: string;
      readonly archive: Uint8Array;
    }) => publishRelease(http, { ...input, remote, token }).pipe(Effect.scoped);
  }),
  origin: Registry.credentials({ home }).pipe(Effect.map(({ origin }) => origin)),
  connect: Effect.fn("Registry.connectAuthor")(function* (input: {
    readonly remote: AuthorRemoteHome;
    readonly locator: string;
    readonly requireAuthentication: boolean;
  }) {
    const credentials = yield* Registry.credentials({
      origin: input.remote.origin,
      home,
    });
    if (input.requireAuthentication && !credentials.token)
      return yield* new AuthenticationRequired({
        origin: input.remote.origin,
        scopes: "library:sync,authoring:write",
      });
    return yield* authorSyncApi({ ...input, token: credentials.token });
  }),
});
