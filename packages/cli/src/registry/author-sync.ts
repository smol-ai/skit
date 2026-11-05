import {
  AuthoringAuthenticatedApi,
  CurrentMovedResponse,
  SkitExistsResponse,
  SkitNotFoundResponse,
  ForbiddenOriginResponse,
  ForbiddenResponse,
  InsufficientScopeResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import type { AuthorRemoteHome, AuthorVisibility } from "@smolai/skit-core/author";
import { FailureTypeId, SkitContractError, Sync, type SkitFailure } from "@smolai/skit-core";
import { Data, Effect, Option, Result, Schema, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  registryApiFailureMessage,
} from "./api-client.js";
import { isRegistryTransportError, RegistryHttp } from "./registry-http.js";
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
    httpClient: transport,
    baseUrl: remote.origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(input.token)));
  const failure = (context: string, successStatus: number) => (error: unknown) => {
    if (isRegistryTransportError(error))
      return new RegistryUnreachable({ origin: remote.origin, cause: error.cause });
    if (Schema.is(UnauthorizedResponse)(error))
      return new AuthenticationRequired({ scopes: "library:sync,authoring:write" });
    if (Schema.is(InsufficientScopeResponse)(error))
      return new CredentialLacksScope({
        scope: "authoring:write",
        scopes: "library:sync,authoring:write",
      });
    if (Schema.is(ForbiddenResponse)(error) || Schema.is(ForbiddenOriginResponse)(error))
      return new PrincipalNotAuthorized({ action: "author this Namespace or SKIT" });
    if (Schema.is(SkitNotFoundResponse)(error))
      return new RemoteSkitUnavailable({ identity: locator });
    if (isSuccessfulResponseDecodeFailure(error, [successStatus]))
      return new SkitContractError({
        contract: `${context} response`,
        issues: [{ path: "", message: String(error) }],
      });
    return new SyncRejected({
      message: registryApiFailureMessage(context, error, { defaultStatus: 400 }),
    });
  };
  const params = { owner, slug };
  // This SKIT on the Registry, for this command only. The transport never retries, so no retry
  // delay waits while the lease is held.
  const registry: Sync.Remote = {
    current: client.skits.current({ params }).pipe(
      Effect.map((skit) => skit.current),
      Effect.mapError(failure("skit current", 200)),
    ),
    revision: (id) =>
      client.skits.revision({ params: { ...params, id } }).pipe(
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
        .pipe(Effect.asVoid, Effect.mapError(failure("skit revision", 200))),
    move: (expected, id) =>
      client.skits.move({ params, payload: { expected, id } }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          Schema.is(CurrentMovedResponse)(error)
            ? new Sync.Moved({ current: error.current })
            : failure("skit move", 200)(error),
        ),
      ),
  };
  return {
    remote: registry,
    requireAvailable: Effect.gen(function* () {
      const existing = yield* client.skits.current({ params }).pipe(Effect.result);
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
          Effect.mapError((error) =>
            Schema.is(SkitExistsResponse)(error)
              ? new DestinationExistsWithoutHistory({ identity: locator })
              : failure("skit create", 201)(error),
          ),
        ),
  };
});
