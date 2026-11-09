/** Passive Author Workspace metadata. Writes remain behind workspace.ts leases. */
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import {
  AUTHOR_WORKSPACE_METADATA_FILE,
  COLLECTION_CONTROL_DIRECTORY,
} from "../artifact/control-files.js";
import { isErrno } from "../shared/errno.js";
import { AuthorWorkspaceMetadataInvalid, AuthorRemoteMetadataInvalid } from "./failures.js";
import { AuthorRemoteHome, normalizeRemote } from "./remote.js";

/** `workspace_<32 hex>`. Device-local, never portable (ADR-0026). */
export const WorkspaceId = Schema.String.check(Schema.isPattern(/^workspace_[a-f0-9]{32}$/u)).pipe(
  Schema.brand("WorkspaceId"),
);
export type WorkspaceId = typeof WorkspaceId.Type;

/**
 * The workspace's device-local identity. Whether its Collection is in the Library is the
 * Library's state, never stored here: a workspace is registered while the Library retains a
 * Collection imported from it.
 */
export const Identity = Schema.Struct({ workspaceId: WorkspaceId });
export type Identity = typeof Identity.Type;

/**
 * .skit/workspace.json, skit.author-workspace.v1. Files written by 0.3.0 carry a `registration`
 * key; it is read and ignored, and never written again.
 */
const WorkspaceDocument = Schema.Struct({
  schema: Schema.Literal("skit.author-workspace.v1"),
  workspace_id: WorkspaceId,
  registration: Schema.optionalKey(Schema.Literals(["registered", "removing", "removed"])),
});

/** Passive metadata reads also serve Library source reports; serialization stays with Author. */
export const readAuthorIdentity = Effect.fn("AuthorWorkspace.readIdentity")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = join(root, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE);
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );
  if (Option.isNone(text)) return Option.none<Identity>();
  const document = yield* Schema.decodeEffect(Schema.fromJsonString(WorkspaceDocument), {
    onExcessProperty: "error",
  })(text.value).pipe(Effect.mapError(() => new AuthorWorkspaceMetadataInvalid({ path: file })));
  return Option.some(Identity.make({ workspaceId: document.workspace_id }));
});

export const readAuthorRemote = Effect.fn("AuthorWorkspace.readRemote")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = join(root, "skit.remote.json");
  const invalid = () => new AuthorRemoteMetadataInvalid({ path: file });
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchTag("PlatformError", (error) =>
      isErrno(error, "ENOENT") ? Effect.succeedNone : Effect.fail(invalid()),
    ),
  );
  if (Option.isNone(text)) return Option.none<AuthorRemoteHome>();
  const document = yield* Schema.decodeEffect(Schema.fromJsonString(AuthorRemoteHome), {
    onExcessProperty: "error",
  })(text.value).pipe(Effect.mapError(invalid));
  const normalized = yield* normalizeRemote(document).pipe(
    Effect.catchTags({
      AuthorDestinationInvalid: () => Effect.fail(invalid()),
      AuthorDestinationMalformed: () => Effect.fail(invalid()),
      InsecureOrigin: () => Effect.fail(invalid()),
    }),
  );
  if (!Schema.toEquivalence(AuthorRemoteHome)(document, normalized)) return yield* invalid();
  return Option.some(normalized);
});
