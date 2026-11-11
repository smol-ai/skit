import {
  AuthorListResponseError,
  AuthorSkitNotFound,
  AuthorDeleteResponseError,
  AuthorListPaginationError,
} from "./request-failures.js";
import { type AuthorSkitListResponse } from "@smolai/skit-core/api";
import {
  AuthoringAuthenticatedApi,
  DeleteRequiresPrivateResponse,
  SkitNotFoundResponse,
} from "@smolai/skit-core/api";
import type { AuthorRemoteHome } from "@smolai/skit-core/author";
import { Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  classifyRegistryApiFailure,
  registryContractFailure,
  markRegistryResponseDecoding,
  registryApiFailure,
} from "./api-client.js";
import { RegistryHttp } from "./registry-http.js";
import type { ResolvedAuth } from "./accounts.js";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  DeleteRequiresPrivate,
  RegistryOriginInvalid,
  RegistryUnreachable,
} from "./failures.js";

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
const authorInventoryApi = Effect.fn("Registry.authorInventory")(function* (input: {
  origin?: string;
  token?: string;
}) {
  if (!input.origin || !input.token)
    return yield* new AuthenticationRequired({ origin: input.origin, scopes: "authoring:write" });
  const parse = (value: string) =>
    Schema.decodeEffect(Schema.URLFromString)(value).pipe(
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
            return registryContractFailure("author SKIT list request", classified.failure);
          const failure = registryApiFailure(error);
          if (failure.status === 401)
            return new AuthenticationRequired({ origin, scopes: "authoring:write" });
          if (classified.kind === "response_decode")
            return registryContractFailure("author SKIT list response", classified.failure);
          return new AuthorListResponseError({
            origin,
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.code === undefined ? {} : { registryCode: failure.code }),
            failure: error,
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
          return registryContractFailure("author SKIT delete request", classified.failure);
        if (Schema.is(SkitNotFoundResponse)(error)) return new AuthorSkitNotFound();
        if (Schema.is(DeleteRequiresPrivateResponse)(error)) return new DeleteRequiresPrivate();
        if (classified.kind === "response_decode")
          return registryContractFailure("author SKIT delete response", classified.failure);
        const response = registryApiFailure(error);
        return new AuthorDeleteResponseError({
          origin: remote.origin,
          ...(response.status === undefined ? {} : { status: response.status }),
          ...(response.code === undefined ? {} : { registryCode: response.code }),
          failure: error,
        });
      }),
    );
});

export const listAuthorInventory = Effect.fn("Registry.listAuthorInventory")(function* (input: {
  origin?: string;
  token?: string;
}) {
  const api = yield* authorInventoryApi(input);
  const origin = api.origin;
  const skits: Array<AuthorSkitListResponse["skits"][number]> = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let pages = 0;
  do {
    const page: AuthorSkitListResponse = yield* api.readPage(cursor);
    skits.push(...page.skits);
    cursor = page.next_cursor;
    pages++;
    if (cursor && (cursors.has(cursor) || pages >= 1_000 || skits.length > 100_000))
      return yield* new AuthorListPaginationError({ origin });
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { origin, skits };
}, Effect.scoped);

/** Adapt the command's captured account without leaking its credential into Author. */
export const authorInventoryRegistry = (account: ResolvedAuth) => ({
  list: listAuthorInventory(account),
});
