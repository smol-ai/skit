import { AUTHOR_WORKSPACE_METADATA_FILE, COLLECTION_CONTROL_DIRECTORY } from "@smolai/skit-core";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { AuthorWorkspaceMetadataInvalid } from "./failures.js";

const AUTHOR_WORKSPACE_SCHEMA = "skit.author-workspace.v1" as const;

export interface AuthorWorkspaceMetadata {
  readonly schema: typeof AUTHOR_WORKSPACE_SCHEMA;
  readonly workspace_id: string;
  readonly registration?: "registered" | "removed";
}

const AuthorWorkspaceDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal(AUTHOR_WORKSPACE_SCHEMA),
    workspace_id: Schema.String.check(Schema.isPattern(/^workspace_[a-f0-9]{32}$/)),
    registration: Schema.optionalKey(Schema.Literals(["registered", "removed"])),
  }),
);

const metadataPath = (root: string) =>
  join(root, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE);

export const readAuthorWorkspaceEffect = Effect.fn("Library.readAuthorWorkspace")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = metadataPath(root);
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return undefined;
  const value = yield* Schema.decodeUnknownEffect(AuthorWorkspaceDocument, {
    onExcessProperty: "error",
  })(text).pipe(Effect.mapError(() => new AuthorWorkspaceMetadataInvalid({ path })));
  return {
    schema: value.schema,
    workspace_id: value.workspace_id,
    registration:
      "registration" in value && value.registration === "removed"
        ? "removed"
        : "registration" in value && value.registration === "registered"
          ? "registered"
          : undefined,
  } satisfies AuthorWorkspaceMetadata;
});

export const writeAuthorWorkspaceEffect = Effect.fn("Library.writeAuthorWorkspace")(function* (
  root: string,
  metadata: AuthorWorkspaceMetadata,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(metadataPath(root), `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
  });
});
