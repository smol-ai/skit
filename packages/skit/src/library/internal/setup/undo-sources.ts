import type { UndoConflict } from "../../recovery-facts.js";
import { Clock, Effect } from "effect";
import { makeImportId, type CollectionId, type MachineId } from "../../entity-ids.js";
import { originalTreeHash, collectionVersionPath } from "../../collection-version.js";
import { sourceImports, type Import } from "../../library-contracts.js";
import { type LibraryState } from "../../library-state.js";
import { type SetupIntent } from "./intent.js";

export interface UndoSourceImport {
  readonly importId: Import["import_id"];
  readonly checkedAt: string;
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
  const conflicts: UndoConflict[] = [];
  const restorations: Import[] = [];
  const evidence: { path: string; hash: string }[] = [];
  for (const prior of before.sources ?? []) {
    const after = expected.sources?.find((item) => item.collectionId === prior.collectionId);
    if (!after || after.collectionVersionId === prior.collectionVersionId) continue;
    const current = sourceImports(state, prior.collectionId)[0];
    if (current?.collection_version_id === prior.collectionVersionId) continue;
    if (current?.collection_version_id !== after.collectionVersionId) {
      conflicts.push({ _tag: "SourceChanged", collectionId: prior.collectionId });
      continue;
    }
    const original = state.imports.find(
      (item) =>
        item.import_id === prior.importId &&
        item.collection_id === prior.collectionId &&
        item.kind === "source" &&
        item.collection_version_id === prior.collectionVersionId,
    );
    const copy = state.collection_versions.find(
      (item) => item.collection_version_id === prior.collectionVersionId,
    );
    if (!original || !copy || !machineId) {
      conflicts.push({ _tag: "SourceEvidenceMissing", collectionId: prior.collectionId });
      continue;
    }
    const path = collectionVersionPath(originalsPath, copy.hash);
    const verified = yield* Effect.result(originalTreeHash(path));
    if (verified._tag === "Failure" || verified.success !== copy.hash) {
      conflicts.push({ _tag: "SourceBytesChanged", collectionId: prior.collectionId });
      continue;
    }
    evidence.push({ path, hash: verified.success });
    let sourceImport = observations.get(prior.collectionId);
    if (!sourceImport) {
      sourceImport = {
        importId: makeImportId(),
        checkedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      };
      observations.set(prior.collectionId, sourceImport);
    }
    if (state.imports.some((item) => item.import_id === sourceImport.importId)) {
      conflicts.push({ _tag: "ImportAlreadyRecorded", collectionId: prior.collectionId });
      continue;
    }
    const now = Date.parse(sourceImport.checkedAt);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(Date.parse(current.imported_at)) ||
      now <= Date.parse(current.imported_at) ||
      sourceImport.checkedAt <= current.imported_at
    ) {
      conflicts.push({ _tag: "ClockNotAdvanced", collectionId: prior.collectionId });
      continue;
    }
    restorations.push({
      kind: "source",
      collection_id: original.collection_id,
      collection_version_id: original.collection_version_id,
      source_identity: original.source_identity,
      ...(original.revision === undefined ? {} : { revision: original.revision }),
      import_id: sourceImport.importId,
      imported_at: sourceImport.checkedAt,
      machine_id: machineId,
      input: { value: path },
      // Old lock/source assertions are history; reading retained bytes is not a new upstream probe.
      lock_file_entries: [],
    });
  }
  return {
    conflicts,
    evidence,
    restorations,
  };
});
