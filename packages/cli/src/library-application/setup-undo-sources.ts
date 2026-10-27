import { Clock, Effect } from "effect";
import {
  makeImportId,
  originalTreeHash,
  retainedTreePath,
  sourceImports,
  type Import,
  type CollectionId,
  type LibraryState,
  type MachineId,
} from "@smolai/skit-core";
import type { SetupIntent } from "./setup-undo-intent.js";

export interface UndoSourceImport {
  readonly acquisitionId: Import["acquisition_id"];
  readonly observedAt: string;
}

/** Re-observe verified retained source bytes, preserving all histories and ordinary refresh rules. */
export const prepareSetupSourceUndo = Effect.fn("SetupUndo.prepareSources")(function* (
  state: LibraryState,
  before: SetupIntent,
  expected: SetupIntent,
  originalsPath: string,
  machineId: MachineId | undefined,
  observations: Map<CollectionId, UndoSourceImport>,
) {
  const conflicts: string[] = [];
  const restorations: Import[] = [];
  const evidence: { path: string; hash: string }[] = [];
  for (const prior of before.sources ?? []) {
    const after = expected.sources?.find((item) => item.collectionId === prior.collectionId);
    if (!after || after.retainedCopyId === prior.retainedCopyId) continue;
    const current = sourceImports(state, prior.collectionId)[0];
    if (current?.retained_copy_id === prior.retainedCopyId) continue;
    if (current?.retained_copy_id !== after.retainedCopyId) {
      conflicts.push(`Collection source changed after setup: ${prior.collectionId}`);
      continue;
    }
    const original = state.acquisitions.find(
      (item) =>
        item.acquisition_id === prior.acquisitionId &&
        item.collection_id === prior.collectionId &&
        item.kind === "source" &&
        item.retained_copy_id === prior.retainedCopyId,
    );
    const copy = state.retained_copies.find(
      (item) => item.retained_copy_id === prior.retainedCopyId,
    );
    if (!original || !copy || !machineId) {
      conflicts.push(`Prior retained source evidence is unavailable: ${prior.collectionId}`);
      continue;
    }
    const path = retainedTreePath(originalsPath, copy.digest);
    const verified = yield* Effect.result(originalTreeHash(path));
    if (verified._tag === "Failure" || verified.success !== copy.digest) {
      conflicts.push(`Prior retained source bytes changed: ${prior.collectionId}`);
      continue;
    }
    evidence.push({ path, hash: verified.success });
    let observation = observations.get(prior.collectionId);
    if (!observation) {
      observation = {
        acquisitionId: makeImportId(),
        observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      };
      observations.set(prior.collectionId, observation);
    }
    const now = Date.parse(observation.observedAt);
    if (
      !Number.isFinite(Date.parse(current.acquired_at)) ||
      now <= Date.parse(current.acquired_at) ||
      observation.observedAt <= current.acquired_at
    ) {
      conflicts.push(
        `Clock has not advanced past the current source observation: ${prior.collectionId}`,
      );
      continue;
    }
    restorations.push({
      kind: "source",
      collection_id: original.collection_id,
      retained_copy_id: original.retained_copy_id,
      source_identity: original.source_identity,
      ...(original.revision === undefined ? {} : { revision: original.revision }),
      acquisition_id: observation.acquisitionId,
      acquired_at: observation.observedAt,
      machine_id: machineId,
      input: { value: path },
      // Old lock/source assertions are history; reading retained bytes is not a new upstream probe.
      observations: [],
    });
  }
  return {
    conflicts,
    evidence,
    restorations,
  };
});
