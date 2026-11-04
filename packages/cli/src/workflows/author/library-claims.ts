import type { Collection, LibraryState } from "@smolai/skit-core";
import { Effect, FileSystem, Option, Schema } from "effect";
import { WorkspaceId, type WorkspaceRoot } from "../../author/workspace.js";

/** The workspace id an authored Collection carries, if it is one. */
export const authoredId = (collection: Collection | undefined) =>
  collection?.upstream?.source_identity.kind === "authored-workspace"
    ? collection.upstream.source_identity.workspace_id
    : undefined;

/** The Collections whose imports name this root, in Library order (A3). */
export const collectionsAt = Effect.fn("Author.collectionsAt")(function* (
  root: WorkspaceRoot,
  state: LibraryState,
) {
  const fs = yield* FileSystem.FileSystem;
  const sameRoot: Collection[] = [];
  for (const collection of state.collections) {
    const inputs = state.imports
      .filter((sourceImport) => sourceImport.collection_id === collection.collection_id)
      .map((sourceImport) => sourceImport.input.value);
    for (const input of inputs)
      if ((yield* fs.exists(input)) && (yield* fs.realPath(input)) === root) {
        sameRoot.push(collection);
        break;
      }
  }
  return sameRoot;
});

/**
 * The id to reuse when workspace.json has gone: that of the first authored Collection imported
 * from this root (A3).
 */
export const adoptFrom = (sameRoot: readonly Collection[]) =>
  Option.flatMap(
    Option.fromUndefinedOr(sameRoot.map(authoredId).find((id) => id !== undefined)),
    Schema.decodeUnknownOption(WorkspaceId),
  );
