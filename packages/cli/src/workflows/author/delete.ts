import {
  AuthoringAuthenticatedApi,
  DeleteRequiresPrivateResponse,
  InsufficientScopeResponse,
  SkitNotFoundResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import { Data, Effect, Result, Schema, Scope } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { AuthorSkitDeleteResponse, SkitContractError } from "@smolai/skit-core";
import type { AuthorRemoteHome } from "./sync.js";
import { parseAuthorDestinationEffect } from "./sync.js";
import { NothingToSelect } from "../../presentation/interaction-failures.js";
import { DeleteRequiresPrivate } from "../../registry/failures.js";
import { AuthenticationRequired, CredentialLacksScope } from "../../registry/failures.js";
import { resolveAuthForOriginEffect, type ResolvedAuth } from "../../registry/auth.js";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  mapRegistryFailureCause,
  registryApiFailureMessage,
} from "../../registry/api-client.js";
import { isRegistryTransportError, RegistryHttp } from "../../registry/registry-http.js";
import { Renderer } from "../../presentation/renderer.js";
import { handleCommand } from "../../application.js";
import { resolveAuthEffect } from "../../registry/auth.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, homePath, jsonFlag } from "../../commands/parameters.js";
import { result } from "../../handlers/contracts.js";

export class AuthorDeleteHttpError extends Data.TaggedError("AuthorDeleteHttpError")<{
  message: string;
  cause: Error;
}> {}
export class AuthorDeleteResponseError extends Data.TaggedError("AuthorDeleteResponseError")<{
  message: string;
}> {}

/**
 * Delete one private SKIT, or plan the deletion under `dryRun`.
 *
 * The request and its body read share the caller's Scope, so an interrupted deletion releases the
 * connection rather than leaving the body streaming. This never retries: a delete that may have
 * been accepted must not be sent twice.
 */
export const deleteAuthorSkitEffect = Effect.fn("deleteAuthorSkitEffect")(function* (
  remote: AuthorRemoteHome,
  options: { token?: string; dryRun?: boolean },
): Effect.fn.Return<
  AuthorSkitDeleteResponse,
  | AuthenticationRequired
  | CredentialLacksScope
  | DeleteRequiresPrivate
  | NothingToSelect
  | AuthorDeleteHttpError
  | AuthorDeleteResponseError
  | SkitContractError,
  RegistryHttp | Scope.Scope
> {
  if (!options.token)
    return yield* Effect.fail(
      new AuthenticationRequired({ origin: remote.origin, scopes: "authoring:write" }),
    );
  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    httpClient: transport,
    baseUrl: remote.origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(options.token)));
  return yield* client.skitDelete
    .deletePrivate({
      params: { owner: remote.namespace, slug: remote.skit },
      query: options.dryRun ? { dry_run: "true" } : {},
    })
    .pipe((effect) =>
      mapRegistryFailureCause(effect, (error) => {
        if (isRegistryTransportError(error))
          return new AuthorDeleteHttpError({
            message: `Unable to reach Registry ${remote.origin}: ${error.message}`,
            cause: error,
          });
        if (Schema.is(UnauthorizedResponse)(error))
          return new AuthenticationRequired({
            origin: remote.origin,
            scopes: "authoring:write",
          });
        if (Schema.is(InsufficientScopeResponse)(error))
          return new CredentialLacksScope({ scope: "authoring:write", origin: remote.origin });
        if (Schema.is(SkitNotFoundResponse)(error))
          return new NothingToSelect({
            detail: "The private SKIT was not found or is not owned by you",
          });
        if (Schema.is(DeleteRequiresPrivateResponse)(error)) return new DeleteRequiresPrivate();
        if (isSuccessfulResponseDecodeFailure(error, [200]))
          return new SkitContractError("author SKIT delete response", [
            { path: "", message: String(error) },
          ]);
        return new AuthorDeleteResponseError({
          message: registryApiFailureMessage("Author SKIT delete", error),
        });
      }),
    );
});

export interface AuthorDeleteOptions<E> {
  readonly authState: Result.Result<ResolvedAuth, E>;
  readonly home?: string;
  readonly dryRun?: boolean;
}

/** Resolve one startup snapshot, destination and credential before issuing one scoped DELETE. */
export const authorDeleteCommand = Effect.fn("CLI.authorDelete")(function* <E>(
  destination: string,
  options: AuthorDeleteOptions<E>,
) {
  const concrete = /^(?:skit:\/\/|https?:\/\/)/.test(destination);
  const startup = concrete ? undefined : yield* Effect.fromResult(options.authState);
  const remote = yield* parseAuthorDestinationEffect(destination, startup?.origin);
  const credentials = yield* resolveAuthForOriginEffect(remote.origin, options.home);
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    options.dryRun ? "Planning private SKIT deletion" : "Deleting private SKIT",
    Effect.scoped(
      deleteAuthorSkitEffect(remote, { token: credentials.token, dryRun: options.dryRun }),
    ),
  );
});

const skit = Argument.string("skit");
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Preview the private Draft and Releases that would be deleted."),
  Flag.withDefault(false),
);

export const authorDeleteCliCommand = Command.make(
  "delete",
  { skit, dryRun, home: homeFlag, json: jsonFlag },
  ({ skit, dryRun, home }) => {
    const selectedHome = homePath(home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const authState = yield* resolveAuthEffect(selectedHome).pipe(Effect.result);
        const value = yield* authorDeleteCommand(skit, {
          authState,
          home: selectedHome,
          dryRun,
        });
        yield* renderer.result(result("authorDelete", outputContracts.authorDelete, value));
      }),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription("Permanently delete a private SKIT from its Registry."),
  Command.withExamples([
    { command: "skit author delete skit://skit.example.com/alice/tools --dry-run" },
    { command: "skit author delete skit://skit.example.com/alice/tools" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.authorDelete],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
