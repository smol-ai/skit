import {
  AuthoringAuthenticatedApi,
  InsufficientScopeResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import { Data, Effect, Option, Result, Schema, Scope } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Command } from "effect/unstable/cli";
import { SkitContractError, type AuthorSkitListResponse } from "@smolai/skit-core";
import type { ResolvedAuth } from "../../registry/auth.js";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  mapRegistryFailureCause,
  registryApiFailure,
  registryApiFailureMessage,
} from "../../registry/api-client.js";
import { isRegistryTransportError, RegistryHttp } from "../../registry/registry-http.js";
import { Renderer } from "../../presentation/renderer.js";
import { authorRef } from "./sync.js";
import { AuthenticationRequired, CredentialLacksScope } from "../../registry/failures.js";
import { handleCommand } from "../../application.js";
import { resolveAuthEffect } from "../../registry/auth.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, homePath, jsonFlag, optionalString } from "../../commands/parameters.js";
import { result } from "../../handlers/contracts.js";

export type AuthorSkitInventory = typeof outputContracts.authorList.schema.Type;

export class AuthorListHttpError extends Data.TaggedError("AuthorListHttpError")<{
  message: string;
  cause: Error;
}> {}
export class AuthorListResponseError extends Data.TaggedError("AuthorListResponseError")<{
  message: string;
}> {}
export class AuthorListPaginationError extends Data.TaggedError("AuthorListPaginationError")<{
  origin: string;
}> {
  get message() {
    return `Registry ${this.origin} returned non-progressing or excessive inventory pages`;
  }
}
export class AuthorListIdentityError extends Data.TaggedError("AuthorListIdentityError")<{
  identity: string;
}> {
  get message() {
    return `Registry returned invalid SKIT identity: ${this.identity}`;
  }
}
export class AuthorListOriginInvalid extends Data.TaggedError("AuthorListOriginInvalid")<{
  origin: string;
}> {
  get message() {
    return `Invalid Registry URL: ${this.origin}`;
  }
}
export type AuthorListFailure =
  | AuthenticationRequired
  | CredentialLacksScope
  | AuthorListHttpError
  | AuthorListResponseError
  | SkitContractError
  | AuthorListPaginationError
  | AuthorListIdentityError
  | AuthorListOriginInvalid;

const parseUrl = (input: string) =>
  Schema.decodeUnknownEffect(Schema.URLFromString)(input).pipe(
    Effect.mapError(() => new AuthorListOriginInvalid({ origin: input })),
  );

const classifyListFailure = (origin: string, error: unknown): AuthorListFailure => {
  if (isRegistryTransportError(error))
    return new AuthorListHttpError({
      message: `Unable to reach Registry ${origin}: ${error.message}`,
      cause: error,
    });
  if (Schema.is(UnauthorizedResponse)(error))
    return new AuthenticationRequired({ origin, scopes: "authoring:write" });
  if (Schema.is(InsufficientScopeResponse)(error))
    return new CredentialLacksScope({ scope: "authoring:write", origin });
  const failure = registryApiFailure(error);
  if (failure.status === 401)
    return new AuthenticationRequired({ origin, scopes: "authoring:write" });
  if (isSuccessfulResponseDecodeFailure(error, [200]))
    return new SkitContractError("author SKIT list response", [
      { path: "", message: String(error) },
    ]);
  if (failure.status !== undefined || failure.code !== undefined)
    return new AuthorListResponseError({
      message: registryApiFailureMessage("Author SKIT list", error),
    });
  return new AuthorListResponseError({ message: "Registry returned an invalid response" });
};

export const listAuthorSkitsEffect = Effect.fn("listAuthorSkitsEffect")(function* (input: {
  origin?: string;
  token?: string;
}): Effect.fn.Return<AuthorSkitInventory, AuthorListFailure, RegistryHttp | Scope.Scope> {
  const configuredOrigin = input.origin;
  if (!configuredOrigin || !input.token)
    return yield* Effect.fail(
      new AuthenticationRequired({ origin: input.origin, scopes: "authoring:write" }),
    );
  const origin = (yield* parseUrl(configuredOrigin)).origin;
  // Opaque origins were rejected by the old authorRef probe before making a request.
  yield* parseUrl(origin);
  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    httpClient: transport,
    baseUrl: origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(input.token)));
  const skits: Array<AuthorSkitListResponse["skits"][number]> = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let pages = 0;
  do {
    const page: AuthorSkitListResponse = yield* client.authorInventory
      .read({ query: cursor === null ? {} : { cursor } })
      .pipe((effect) =>
        mapRegistryFailureCause(effect, (error) => classifyListFailure(origin, error)),
      );
    skits.push(...page.skits);
    cursor = page.next_cursor;
    pages++;
    if (cursor && (cursors.has(cursor) || pages >= 1_000 || skits.length > 100_000))
      return yield* Effect.fail(new AuthorListPaginationError({ origin }));
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const inventory = yield* Effect.forEach(skits, (skit) =>
    Effect.gen(function* () {
      const separator = skit.skit_id.indexOf("/");
      if (separator < 1 || separator === skit.skit_id.length - 1)
        return yield* Effect.fail(new AuthorListIdentityError({ identity: skit.skit_id }));
      return {
        identity: authorRef({
          schema: "skit.remote.v1",
          origin,
          namespace: skit.skit_id.slice(0, separator),
          skit: skit.skit_id.slice(separator + 1),
        }),
        visibility: skit.visibility,
        draft_revision_id: skit.draft_revision_id,
        most_recent_release_version: skit.most_recent_release_version,
      };
    }),
  );
  return { registry: origin, skits: inventory };
}, Effect.scoped);

export interface AuthorListOptions<E> {
  readonly authState: Result.Result<ResolvedAuth, E>;
  readonly registry?: string;
  readonly home?: string;
}

export const authorListCommand = Effect.fn("CLI.authorList")(function* <E>(
  options: AuthorListOptions<E>,
) {
  const selected = yield* Effect.fromResult(options.authState);
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Listing authored SKITs",
    listAuthorSkitsEffect({ origin: selected.origin, token: selected.token }),
  );
});

const registry = optionalString("registry", "Select a Registry by alias or origin.");

export const authorListCliCommand = Command.make(
  "list",
  { registry, home: homeFlag, json: jsonFlag },
  ({ registry, home }) => {
    const selectedHome = homePath(home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const selectedRegistry = Option.getOrUndefined(registry);
        const authState = yield* resolveAuthEffect(
          selectedHome,
          selectedRegistry,
          undefined,
          "skit author list",
        ).pipe(Effect.result);
        const value = yield* authorListCommand({
          authState,
          registry: selectedRegistry,
          home: selectedHome,
        });
        yield* renderer.result(result("authorList", outputContracts.authorList, value));
      }),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription("List SKITs the active Principal can author on a Registry."),
  Command.withExamples([
    { command: "skit author list" },
    { command: "skit author list --registry https://skit.example.com" },
    { command: "skit author list --json" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.authorList],
    exitCodes: [0, 12, 64],
    interactive: false,
  }),
);
