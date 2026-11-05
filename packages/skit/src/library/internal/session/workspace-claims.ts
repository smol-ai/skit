import { Effect, FileSystem } from "effect";
import type { LibraryState } from "../../library-state.js";

export interface WorkspaceClaim {
  readonly collectionId: string;
  readonly workspaceId?: string;
}

/** Provenance and canonical paths from one captured Library; Author decides registration. */
export const readWorkspaceClaims = Effect.fn("LibraryView.readWorkspaceClaims")(function* (
  state: LibraryState,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const workspaceIdOf = (collection: LibraryState["collections"][number]) =>
    collection.upstream?.source_identity.kind === "authored-workspace"
      ? collection.upstream.source_identity.workspace_id
      : undefined;
  const atRoot: WorkspaceClaim[] = [];
  for (const collection of state.collections) {
    const inputs = state.imports
      .filter((sourceImport) => sourceImport.collection_id === collection.collection_id)
      .map((sourceImport) => sourceImport.input.value);
    for (const input of inputs)
      if ((yield* fs.exists(input)) && (yield* fs.realPath(input)) === root) {
        const workspaceId = workspaceIdOf(collection);
        atRoot.push({
          collectionId: collection.collection_id,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        });
        break;
      }
  }
  return {
    atRoot,
    readRegistration: Effect.fn("LibraryView.readWorkspaceRegistration")(function* (
      workspaceId: string,
    ) {
      const collection = state.collections.find((item) => workspaceIdOf(item) === workspaceId);
      if (collection === undefined) return undefined;
      const input = state.imports.find(
        (sourceImport) => sourceImport.collection_id === collection.collection_id,
      )?.input.value;
      return {
        collectionId: collection.collection_id,
        ...(input === undefined ? {} : { input }),
        ...(input !== undefined && (yield* fs.exists(input))
          ? { root: yield* fs.realPath(input) }
          : {}),
      };
    }),
  };
});
