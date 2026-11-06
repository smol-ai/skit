import { SkitContractError } from "@smolai/skit-core/api";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import {
  AuthoringAuthenticatedApi,
  DeleteRequiresPrivateResponse,
  SkitNotFoundResponse,
} from "@smolai/skit-core/universal/api";
import type { AuthorRemoteHome } from "@smolai/skit-core/author";
import { Data, Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  classifyRegistryApiFailure,
  markRegistryResponseDecoding,
  registryApiFailure,
  registryApiFailureMessage,
} from "./api-client.js";
import { RegistryHttp } from "./registry-http.js";
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
class AuthorSkitNotFound extends Data.TaggedError("AuthorSkitNotFound")<{}> implements SkitFailure {
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation =
    "Check the destination, and that you are signed in as its owner, then retry.";
  get message(): string {
    return "The private SKIT was not found or is not owned by you";
  }
}
class AuthorDeleteResponseError
  extends Data.TaggedError("AuthorDeleteResponseError")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then retry.";
}

/** Common authoring failures; endpoint-specific status and decode rules stay below. */
const authoringFailure = (
  origin: string,
  failure: ReturnType<typeof classifyRegistryApiFailure>,
) => {
  if (failure.kind === "transport")
    return new RegistryUnreachable({ origin, cause: failure.error });
  if (failure.kind === "unauthorized")
    return new AuthenticationRequired({ origin, scopes: "authoring:write" });
  if (failure.kind === "insufficient_scope")
    return new CredentialLacksScope({ scope: "authoring:write", origin });
  return undefined;
};
const authoringClient = Effect.fn("Registry.authoringClient")(function* (
  origin: string,
  token: string,
) {
  const transport = yield* (yield* RegistryHttp).client;
  return yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    transformResponse: markRegistryResponseDecoding,
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
          const classified = classifyRegistryApiFailure(error, [200]);
          const common = authoringFailure(origin, classified);
          if (common) return common;
          if (classified.kind === "request_encoding")
            return new SkitContractError({
              contract: "author SKIT list request",
              issues: [{ path: "", message: String(error) }],
            });
          const failure = registryApiFailure(error);
          if (failure.status === 401)
            return new AuthenticationRequired({ origin, scopes: "authoring:write" });
          if (classified.kind === "response_decode")
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
        const classified = classifyRegistryApiFailure(error, [200]);
        const common = authoringFailure(remote.origin, classified);
        if (common) return common;
        if (classified.kind === "request_encoding")
          return new SkitContractError({
            contract: "author SKIT delete request",
            issues: [{ path: "", message: String(error) }],
          });
        if (Schema.is(SkitNotFoundResponse)(error)) return new AuthorSkitNotFound();
        if (Schema.is(DeleteRequiresPrivateResponse)(error)) return new DeleteRequiresPrivate();
        if (classified.kind === "response_decode")
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

// Error names are required by inferred consumer declarations; constructors stay private.
export type { AuthorSkitNotFound, AuthorDeleteResponseError };
