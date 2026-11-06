import { Effect, FileSystem } from "effect";
import type { LibraryState } from "../../library-state.js";
import { sourceImports } from "../../library-contracts.js";

export interface WorkspaceClaim {
  readonly collectionId: string;
  readonly workspaceId?: string;
}

/** Import history records former locations; only the latest matching source names this one. */
export const workspaceLocation = (
  state: LibraryState,
  collection: LibraryState["collections"][number],
) => {
  const source = collection.upstream?.source_identity;
  if (source?.kind !== "authored-workspace") return undefined;
  const current = sourceImports(state, collection.collection_id).find(
    (item) =>
      item.source_identity.kind === "authored-workspace" &&
      item.source_identity.workspace_id === source.workspace_id,
  );
  return current === undefined
    ? undefined
    : { workspaceId: source.workspace_id, path: current.input.value };
};

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
    const location = workspaceLocation(state, collection);
    const inputs =
      workspaceIdOf(collection) === undefined
        ? state.imports
            .filter((sourceImport) => sourceImport.collection_id === collection.collection_id)
            .map((sourceImport) => sourceImport.input.value)
        : location === undefined
          ? []
          : [location.path];
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
      const input = workspaceLocation(state, collection)?.path;
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
