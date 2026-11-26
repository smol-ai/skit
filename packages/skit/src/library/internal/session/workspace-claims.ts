import { Effect, FileSystem } from "effect";
import type { LibraryState } from "../../library-state.js";
import { localWorkspaceLocations } from "../../collection-source.js";

import * as MachineSettings from "../../machine-settings.js";

export interface WorkspaceClaim {
  readonly collectionId: string;
  readonly workspaceId?: string;
}

/** Provenance and canonical paths from one captured Library; Author decides registration. */
export const readWorkspaceClaims = Effect.fn("LibraryView.readWorkspaceClaims")(function* (
  state: LibraryState,
  root: string,
  home: string,
) {
  const machineId = yield* MachineSettings.readIdentity(home);
  const fs = yield* FileSystem.FileSystem;
  const workspaceIdOf = (collection: LibraryState["collections"][number]) =>
    collection.upstream?.source_identity.kind === "authored-workspace"
      ? collection.upstream.source_identity.workspace_id
      : undefined;
  const atRoot: WorkspaceClaim[] = [];
  const registrations = new Map<
    string,
    { collectionId: string; input?: string; sourceWorkspaceId: string }
  >();
  for (const collection of state.collections) {
    const locations = yield* localWorkspaceLocations(state, collection, home);
    if (locations.length > 1) {
      // An occupied root with no adoptable identity makes init refuse a second Collection.
      if (locations.some((item) => item.path === root))
        atRoot.push({ collectionId: collection.collection_id });
      continue;
    }
    const location = locations[0];
    const sourceWorkspaceId = workspaceIdOf(collection);
    if (sourceWorkspaceId !== undefined) {
      registrations.set(location?.workspaceId ?? sourceWorkspaceId, {
        collectionId: collection.collection_id,
        sourceWorkspaceId,
        ...(location ? { input: location.path } : {}),
      });
    }
    const inputs =
      workspaceIdOf(collection) === undefined
        ? state.imports
            .filter(
              (sourceImport) =>
                machineId !== undefined &&
                sourceImport.machine_id === machineId &&
                sourceImport.collection_id === collection.collection_id,
            )
            .map((sourceImport) => sourceImport.input.value)
        : location === undefined
          ? []
          : [location.path];
    for (const input of inputs)
      if ((yield* fs.exists(input)) && (yield* fs.realPath(input)) === root) {
        const workspaceId = location?.workspaceId;
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
      const registration = registrations.get(workspaceId);
      if (!registration) return undefined;
      const input = registration.input;
      return {
        ...registration,
        ...(input !== undefined && (yield* fs.exists(input))
          ? { root: yield* fs.realPath(input) }
          : {}),
      };
    }),
  };
});
