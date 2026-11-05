import type { PlatformError } from "effect/PlatformError";
import { Registry } from "../../registry/index.js";
import { type Config, Effect, FileSystem, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { join, resolve } from "node:path";
import {
  createSkitArchive,
  SkitContractError,
  type DescriptorFailure,
  type ReleasePublishResponse,
  type SkitValidationFailed,
  readSkitDescriptor,
  validateSkitDirectory,
} from "@smolai/skit-core";
import { type TreeError } from "@smolai/skit-core/shared";
import { type TreeRequirements, type SkitConfiguration } from "@smolai/skit-core/platform";
import { RegistryHttp, RegistryTransportError } from "../../registry/registry-http.js";
import { publishRelease, PublicationResponseError } from "../../registry/publication.js";
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
  // Only this remote's credential: an environment token for another Registry is never sent.
  const credentials = yield* Registry.credentials({ origin: remote.origin, home: options.home });
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
  const bytes = yield* fs.readFile(archive);
  return yield* publishRelease({
    remote,
    token: credentials.token,
    version,
    revision,
    archive: bytes,
    commandPath,
  });
}, Effect.scoped);
