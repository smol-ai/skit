import { SkitContractError, FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import {
  AuthoringAuthenticatedApi,
  DeleteRequiresPrivateResponse,
  InsufficientScopeResponse,
  SkitNotFoundResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import type { AuthorRemoteHome } from "@smolai/skit-core/author";
import { Data, Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  registryApiFailure,
  registryApiFailureMessage,
} from "./api-client.js";
import { isRegistryTransportError, RegistryHttp } from "./registry-http.js";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  DeleteRequiresPrivate,
  RegistryOriginInvalid,
  RegistryUnreachable,
} from "./failures.js";

export class AuthorListResponseError
  extends Data.TaggedError("AuthorListResponseError")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then retry.";
}
export class AuthorSkitNotFound
  extends Data.TaggedError("AuthorSkitNotFound")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation =
    "Check the destination, and that you are signed in as its owner, then retry.";
  get message(): string {
    return "The private SKIT was not found or is not owned by you";
  }
}
export class AuthorDeleteResponseError
  extends Data.TaggedError("AuthorDeleteResponseError")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then retry.";
}

/** Common authoring failures; endpoint-specific status and decode rules stay below. */
const authoringFailure = (origin: string, error: unknown) => {
  if (isRegistryTransportError(error)) return new RegistryUnreachable({ origin, cause: error });
  if (Schema.is(UnauthorizedResponse)(error))
    return new AuthenticationRequired({ origin, scopes: "authoring:write" });
  if (Schema.is(InsufficientScopeResponse)(error))
    return new CredentialLacksScope({ scope: "authoring:write", origin });
  return undefined;
};
const authoringClient = Effect.fn("Registry.authoringClient")(function* (
  origin: string,
  token: string,
) {
  const transport = yield* (yield* RegistryHttp).client;
  return yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    httpClient: transport,
    baseUrl: origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(token)));
});

/** One scoped inventory client; pagination policy belongs to the Author inventory operation. */
export const authorInventoryApi = Effect.fn("Registry.authorInventory")(function* (input: {
  origin?: string;
  token?: string;
}) {
  if (!input.origin || !input.token)
    return yield* new AuthenticationRequired({ origin: input.origin, scopes: "authoring:write" });
  const parse = (value: string) =>
    Schema.decodeUnknownEffect(Schema.URLFromString)(value).pipe(
      Effect.mapError(() => new RegistryOriginInvalid({ origin: value })),
    );
  const origin = (yield* parse(input.origin)).origin;
  yield* parse(origin);
  const client = yield* authoringClient(origin, input.token);
  return {
    origin,
    readPage: Effect.fn("Registry.readAuthorInventoryPage")(function* (cursor: string | null) {
      return yield* client.authorInventory.read({ query: cursor === null ? {} : { cursor } }).pipe(
        Effect.mapError((error) => {
          const common = authoringFailure(origin, error);
          if (common) return common;
          const failure = registryApiFailure(error);
          if (failure.status === 401)
            return new AuthenticationRequired({ origin, scopes: "authoring:write" });
          if (isSuccessfulResponseDecodeFailure(error, [200]))
            return new SkitContractError({
              contract: "author SKIT list response",
              issues: [{ path: "", message: String(error) }],
            });
          return new AuthorListResponseError({
            message:
              failure.status !== undefined || failure.code !== undefined
                ? registryApiFailureMessage("Author SKIT list", error)
                : "Registry returned an invalid response",
          });
        }),
      );
    }),
  };
});

/** One DELETE, including body decoding in the caller's Scope. Never retries accepted writes. */
export const deletePrivateAuthorSkit = Effect.fn("Registry.deletePrivateAuthorSkit")(function* (
  remote: AuthorRemoteHome,
  options: { token?: string; dryRun?: boolean },
) {
  if (!options.token)
    return yield* new AuthenticationRequired({ origin: remote.origin, scopes: "authoring:write" });
  const client = yield* authoringClient(remote.origin, options.token);
  return yield* client.skitDelete
    .deletePrivate({
      params: { owner: remote.namespace, slug: remote.skit },
      query: options.dryRun ? { dry_run: "true" } : {},
    })
    .pipe(
      Effect.mapError((error) => {
        const common = authoringFailure(remote.origin, error);
        if (common) return common;
        if (Schema.is(SkitNotFoundResponse)(error)) return new AuthorSkitNotFound();
        if (Schema.is(DeleteRequiresPrivateResponse)(error)) return new DeleteRequiresPrivate();
        if (isSuccessfulResponseDecodeFailure(error, [200]))
          return new SkitContractError({
            contract: "author SKIT delete response",
            issues: [{ path: "", message: String(error) }],
          });
        return new AuthorDeleteResponseError({
          message: registryApiFailureMessage("Author SKIT delete", error),
        });
      }),
    );
});
