import { Registry } from "./index.js";
import { listAuthorInventory, deletePrivateAuthorSkit } from "./authoring.js";
import { publishRelease } from "./publication.js";
import {
  AuthoringAuthenticatedApi,
  CurrentMovedResponse,
  SkitExistsResponse,
  SkitNotFoundResponse,
} from "@smolai/skit-core/universal/api";
import type { AuthorRemoteHome, AuthorVisibility } from "@smolai/skit-core/author";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { Moved, type Remote } from "@smolai/skit-core/sync";
import { SkitContractError } from "@smolai/skit-core/api";
import { Data, Effect, Option, Result, Schema, Stream, Scope } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  classifyRegistryApiFailure,
  markRegistryResponseDecoding,
  registryApiFailureMessage,
} from "./api-client.js";
import { RegistryHttp, RegistryTransportError } from "./registry-http.js";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  DestinationExistsWithoutHistory,
  PrincipalNotAuthorized,
  RegistryUnreachable,
  RemoteSkitUnavailable,
} from "./failures.js";

/** A SKIT request the Registry answered, with its own words for why it refused. */
class SyncRejected
  extends Data.TaggedError("SyncRejected")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then sync again.";
}

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
  const failure = (context: string, successStatus: number) => (error: unknown) => {
    const classified = classifyRegistryApiFailure(error, [successStatus]);
    if (classified.kind === "transport")
      return new RegistryUnreachable({ origin: remote.origin, cause: classified.error.cause });
    if (classified.kind === "unauthorized")
      return new AuthenticationRequired({ scopes: "library:sync,authoring:write" });
    if (classified.kind === "insufficient_scope")
      return new CredentialLacksScope({
        scope: "authoring:write",
        scopes: "library:sync,authoring:write",
      });
    if (classified.kind === "forbidden")
      return new PrincipalNotAuthorized({ action: "author this Namespace or SKIT" });
    if (Schema.is(SkitNotFoundResponse)(error))
      return new RemoteSkitUnavailable({ identity: locator });
    if (classified.kind === "response_decode" || classified.kind === "request_encoding")
      return new SkitContractError({
        contract: `${context} ${classified.kind === "request_encoding" ? "request" : "response"}`,
        issues: [{ path: "", message: String(error) }],
      });
    return new SyncRejected({
      message: registryApiFailureMessage(context, error, { defaultStatus: 400 }),
    });
  };
  // Bound the whole generated request, including decoding its body. A headers-only timeout
  // leaves a stalled body holding the workspace lease. Do not retry an ambiguous mutation.
  const withinDeadline = Effect.timeoutOrElse({
    duration: "30 seconds",
    orElse: () =>
      Effect.fail(
        new RegistryTransportError({
          cause: new Error(
            "Author Registry request timed out after 30 seconds; its outcome may be unknown",
          ),
        }),
      ),
  });
  const params = { owner, slug };
  // This SKIT on the Registry, for this command only. The transport never retries, so no retry
  // delay waits while the lease is held.
  const registry: Remote = {
    current: client.skits.current({ params }).pipe(
      withinDeadline,
      Effect.map((skit) => skit.current),
      Effect.mapError(failure("skit current", 200)),
    ),
    revision: (id) =>
      client.skits.revision({ params: { ...params, id } }).pipe(
        withinDeadline,
        Effect.map(({ revision, tree }) => ({ revision, tree })),
        Effect.mapError(failure("skit revision", 200)),
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
            withinDeadline,
            Effect.map(
              (page) =>
                [
                  page.revisions.map(({ id, revision }) => ({ id, revision })),
                  Option.map(Option.fromNullishOr(page.next_cursor), Option.some),
                ] as const,
            ),
            Effect.mapError(failure("skit history", 200)),
          ),
      ),
    post: (id, revision, tree) =>
      client.skits
        .post({ params, payload: { id, revision, tree } })
        .pipe(withinDeadline, Effect.asVoid, Effect.mapError(failure("skit revision", 200))),
    move: (expected, id) =>
      client.skits.move({ params, payload: { expected, id } }).pipe(
        withinDeadline,
        Effect.asVoid,
        Effect.mapError((error) =>
          Schema.is(CurrentMovedResponse)(error)
            ? new Moved({ current: error.current })
            : failure("skit move", 200)(error),
        ),
      ),
  };
  return {
    remote: registry,
    requireAvailable: Effect.gen(function* () {
      const existing = yield* client.skits.current({ params }).pipe(withinDeadline, Effect.result);
      if (Result.isSuccess(existing))
        return yield* new DestinationExistsWithoutHistory({ identity: locator });
      if (!Schema.is(SkitNotFoundResponse)(existing.failure))
        return yield* Effect.fail(failure("skit current", 200)(existing.failure));
    }),
    create: (visibility: AuthorVisibility, requestId: string) =>
      client.skits
        .create({
          payload: { owner, slug, visibility, request_id: requestId },
        })
        .pipe(
          withinDeadline,
          Effect.mapError((error) =>
            Schema.is(SkitExistsResponse)(error)
              ? new DestinationExistsWithoutHistory({ identity: locator })
              : failure("skit create", 201)(error),
          ),
        ),
  };
});

/** Transport composition for Author; credentials are selected only for the named Registry. */
export const authorRegistry = (home?: string, root = ".") => ({
  list: Effect.fn("Registry.listAuthor")(function* () {
    return yield* listAuthorInventory(yield* Registry.credentials({ home }));
  }),
  delete: Effect.fn("Registry.deleteAuthor")(function* (
    remote: AuthorRemoteHome,
    options: { readonly dryRun?: boolean },
  ) {
    const credentials = yield* Registry.credentials({ origin: remote.origin, home });
    return yield* deletePrivateAuthorSkit(remote, { token: credentials.token, ...options });
  }, Effect.scoped),
  publish: Effect.fn("Registry.publishAuthor")(function* (remote: AuthorRemoteHome) {
    const credentials = yield* Registry.credentials({ origin: remote.origin, home });
    if (!credentials.token)
      return yield* new AuthenticationRequired({
        origin: remote.origin,
        scopes: "library:sync,authoring:write,publication:write",
      });
    const token = credentials.token;
    const commandPath = /^[A-Za-z0-9_./-]+$/.test(root)
      ? root
      : `'${root.replaceAll("'", `'\\''`)}'`;
    const registry = yield* RegistryHttp;
    const scope = yield* Scope.Scope;
    return (input: {
      readonly version: string;
      readonly revision?: string;
      readonly archive: Uint8Array;
    }) =>
      publishRelease({ ...input, remote, token, commandPath }).pipe(
        Effect.provideService(RegistryHttp, registry),
        Effect.provideService(Scope.Scope, scope),
      );
  }),
  origin: Registry.credentials({ home }).pipe(Effect.map(({ origin }) => origin)),
  connect: Effect.fn("Registry.connectAuthor")(function* (input: {
    readonly remote: AuthorRemoteHome;
    readonly locator: string;
    readonly requireAuthentication: boolean;
  }) {
    const credentials = yield* Registry.credentials({ origin: input.remote.origin, home });
    if (input.requireAuthentication && !credentials.token)
      return yield* new AuthenticationRequired({
        origin: input.remote.origin,
        scopes: "library:sync,authoring:write",
      });
    return yield* authorSyncApi({ ...input, token: credentials.token });
  }),
});
