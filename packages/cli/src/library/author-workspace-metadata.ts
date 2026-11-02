import { AUTHOR_WORKSPACE_METADATA_FILE, COLLECTION_CONTROL_DIRECTORY } from "@smolai/skit-core";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { AuthorWorkspaceMetadataInvalid } from "./failures.js";

const AUTHOR_WORKSPACE_SCHEMA = "skit.author-workspace.v1" as const;

const AuthorWorkspaceDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal(AUTHOR_WORKSPACE_SCHEMA),
    workspace_id: Schema.String.check(Schema.isPattern(/^workspace_[a-f0-9]{32}$/u)),
    registration: Schema.optionalKey(Schema.Literals(["registered", "removed"])),
  }),
);
export type AuthorWorkspaceMetadata = typeof AuthorWorkspaceDocument.Type;

export const authorWorkspaceMetadataPath = (root: string) =>
  join(root, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE);

export const loadAuthorWorkspaceMetadata = Effect.fn("Library.loadAuthorWorkspaceMetadata")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = authorWorkspaceMetadataPath(root);
    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
    if (text === undefined) return undefined;
    return yield* Schema.decodeUnknownEffect(AuthorWorkspaceDocument, {
      onExcessProperty: "error",
    })(text).pipe(Effect.mapError(() => new AuthorWorkspaceMetadataInvalid({ path })));
  },
);
