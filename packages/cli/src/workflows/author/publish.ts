import type { PlatformError } from "effect/PlatformError";
import { resolveAuthForOrigin } from "../../registry/auth.js";
import { type Config, Data, Effect, FileSystem, Predicate, Schema, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { join, resolve } from "node:path";
import {
  createSkitArchive,
  SkitContractError,
  type DescriptorFailure,
  type ReleasePublishResponse,
  type SkitValidationFailed,
  type TreeError,
  type TreeRequirements,
  parseContract,
  readSkitDescriptor,
  releasePublishRequestSchema,
  validateSkitDirectory,
  type SkitConfiguration,
  FailureTypeId,
  type SkitFailure,
} from "@smolai/skit-core";
import {
  ForbiddenOriginResponse,
  ForbiddenResponse,
  InsufficientScopeResponse,
  IntegrityFailureResponse,
  PublicationAuthenticatedApi,
  PublishBlockedResponse,
  ReleaseConflictResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import {
  isRegistryTransportError,
  RegistryHttp,
  RegistryTransportError,
} from "../../registry/registry-http.js";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  registryApiFailure,
  registryApiFailureMessage,
} from "../../registry/api-client.js";
import {
  AuthorWorkspace,
  type AuthorSyncStateInvalid,
  type AuthorWorkspaceRootInvalid,
  type AuthorWorkspaceMetadataInvalid,
  AuthorRemoteMetadataInvalid,
} from "@smolai/skit-core/author";

import {
  AuthorSyncRequired,
  type CredentialsUnusable,
  NoRemoteHome,
  RegistryRejectedWrite,
  type RegistryOriginInvalid,
  AuthenticationRequired,
  CredentialLacksScope,
  PrincipalNotAuthorized,
  PublicationBlocked,
} from "../../registry/failures.js";

export class PublicationResponseError
  extends Data.TaggedError("PublicationResponseError")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then publish again.";
}
export type PublicationFailure =
  | DescriptorFailure
  | SkitValidationFailed
  | TreeError
  | PlatformError
  | AuthorRemoteMetadataInvalid
  | AuthorWorkspaceMetadataInvalid
  | AuthorSyncStateInvalid
  | AuthorWorkspaceRootInvalid
  | NoRemoteHome
  | RegistryOriginInvalid
  | CredentialsUnusable
  | Config.ConfigError
  | PublicationBlocked
  | AuthenticationRequired
  | CredentialLacksScope
  | PrincipalNotAuthorized
  | AuthorSyncRequired
  | RegistryRejectedWrite
  | RegistryTransportError
  | PublicationResponseError
  | SkitContractError
  | TypeError;

/** The SKIT home whose Registry credentials publish uses. */
type PublishOptions = { readonly home?: string };

function discoveryUrl(template: string, base: string): Effect.Effect<string, TypeError> {
  const url = URL.parse(template, base);
  return url
    ? Effect.succeed(url.toString())
    : Effect.fail(new TypeError(`Invalid URL: ${template} against ${base}`));
}
function stringField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null || !(field in body)) return undefined;
  const value: unknown = Reflect.get(body, field);
  return typeof value === "string" ? value : undefined;
}
export const publish = Effect.fn("publish")(function* (
  root: string,
  version: string,
  revision: string | undefined,
  options: PublishOptions = {},
): Effect.fn.Return<
  ReleasePublishResponse,
  PublicationFailure,
  | TreeRequirements
  | FileSystem.FileSystem
  | RegistryHttp
  | AuthorWorkspace
  | SkitConfiguration
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
> {
  const absolute = resolve(root);
  const commandPath = /^[A-Za-z0-9_./-]+$/.test(root) ? root : `'${root.replaceAll("'", `'\\''`)}'`;
  yield* readSkitDescriptor(absolute);
  const workspaces = yield* AuthorWorkspace;
  // One read: the portable remote is the authority; a leftover checkpoint beside it does not matter.
  const { connection } = yield* workspaces.read(yield* workspaces.resolveRoot(absolute));
  if (connection._tag !== "Connected") return yield* new NoRemoteHome();
  const remote = connection.remote;
  const owner = remote.namespace;
  const slug = remote.skit;
  const base = remote.origin.replace(/\/$/, "");
  // Only this remote's credential: an environment token for another Registry is never sent.
  const credentials = yield* resolveAuthForOrigin(remote.origin, options.home);
  if (!credentials.token)
    return yield* new AuthenticationRequired({
      origin: remote.origin,
      scopes: "library:sync,authoring:write,publication:write",
    });
  // Reject drift locally, before an archive exists: a published Skill's own contents must already
  // satisfy its Descriptor, so a consumer installing it directly honours the author's declaration.
  const validation = yield* validateSkitDirectory(absolute, version, {
    assessmentContext: "publish",
  });
  const blocking = validation.diagnostics.filter((item) => item.severity === "error");
  if (blocking.length)
    return yield* Effect.fail(
      new PublicationBlocked({
        reason: "content",
        detail: blocking.map((item) => `  ${item.message}`).join("\n"),
      }),
    );
  const fs = yield* FileSystem.FileSystem;
  // Cleanup failure is a defect, visible to the command boundary, never silently ignored.
  const temporary = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "skit-publish-" }),
    (path) => fs.remove(path, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const archive = join(temporary, "release.zip");
  yield* createSkitArchive(absolute, archive);
  const http = yield* (yield* RegistryHttp).client;
  const token = credentials.token;
  const bytes = yield* fs.readFile(archive);
  const body = yield* parseContract("publish request", releasePublishRequestSchema, {
    version,
    ...(revision === undefined ? {} : { revision_id: revision }),
    archive_base64: Buffer.from(bytes).toString("base64"),
  });
  let publishUrl = `${base}/api/skits/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/releases`;
  const discovered = yield* Effect.gen(function* () {
    let discovery = yield* http.execute(HttpClientRequest.get(`${base}/.well-known/agent-skills/`));
    if (discovery.status === 404)
      discovery = yield* http.execute(HttpClientRequest.get(`${base}/.well-known/skit`));
    if (discovery.status < 200 || discovery.status >= 300) return undefined;
    const template = stringField(yield* discovery.json, "publish");
    return template === undefined
      ? undefined
      : yield* discoveryUrl(
          template
            .replace("{owner}", encodeURIComponent(owner))
            .replace("{slug}", encodeURIComponent(slug)),
          base,
        );
  }).pipe(
    Effect.catchTags({
      RegistryTransportError: () => Effect.succeed(undefined),
      HttpClientError: () => Effect.succeed(undefined),
    }),
    // Only discovery URL syntax remains in this channel.
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (discovered) publishUrl = discovered;
  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(PublicationAuthenticatedApi, {
    httpClient: HttpClient.mapRequest(transport, HttpClientRequest.setUrl(publishUrl)),
  }).pipe(Effect.provide(authenticatedApiMiddleware(token)));
  return yield* client.publication.publish({ params: { owner, slug }, payload: body }).pipe(
    Effect.catchTag(
      "HttpClientError",
      (
        error,
      ): Effect.Effect<
        never,
        HttpClientError.HttpClientError | RegistryRejectedWrite | PublicationResponseError
      > => {
        if (error.response !== undefined && error.response.status !== 201) {
          const response = error.response;
          return response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((text) => {
              const detail = `SKIT publish failed (${response.status}): ${(text || "Registry returned an invalid error response").slice(0, 1000)}`;
              return Effect.fail(
                response.status === 409
                  ? new RegistryRejectedWrite({ detail })
                  : new PublicationResponseError({ message: detail }),
              );
            }),
          );
        }
        return Effect.fail(error);
      },
    ),
    Effect.mapError((error) => {
      if (
        Predicate.isTagged(error, "PublicationResponseError") ||
        Predicate.isTagged(error, "RegistryRejectedWrite")
      )
        return error;
      if (Schema.is(UnauthorizedResponse)(error))
        return new AuthenticationRequired({
          scopes: "library:sync,authoring:write,publication:write",
        });
      if (Schema.is(InsufficientScopeResponse)(error))
        return new CredentialLacksScope({
          scope: "publication:write",
          scopes: "library:sync,authoring:write,publication:write",
        });
      if (Schema.is(ForbiddenResponse)(error) || Schema.is(ForbiddenOriginResponse)(error))
        return new PrincipalNotAuthorized({ action: "publish this SKIT" });
      if (Schema.is(PublishBlockedResponse)(error)) {
        const details = error.diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => item.message)
          .join("\n");
        return new PublicationBlocked({
          reason: "assessment",
          detail: details ? `:\n${details}` : "",
        });
      }
      if (Schema.is(IntegrityFailureResponse)(error) && error.error === "ARCHIVE_MANIFEST_MISMATCH")
        return new AuthorSyncRequired({ commandPath });
      if (isRegistryTransportError(error)) return error;
      if (isSuccessfulResponseDecodeFailure(error, [201]))
        return new SkitContractError({
          contract: "publish response",
          issues: [{ path: "", message: String(error) }],
        });
      const failure = registryApiFailure(error, { defaultStatus: 400 });
      const detail = registryApiFailureMessage("SKIT publish", error, { defaultStatus: 400 });
      if (failure.status === 409 || Schema.is(ReleaseConflictResponse)(error))
        return new RegistryRejectedWrite({ detail });
      if (Schema.is(IntegrityFailureResponse)(error)) return new RegistryRejectedWrite({ detail });
      return new PublicationResponseError({ message: detail });
    }),
  );
}, Effect.scoped);
