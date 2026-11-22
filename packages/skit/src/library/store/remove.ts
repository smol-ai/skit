import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import type { CollectionId } from "../entity-ids.js";
import { InstalledSkill } from "../device-state.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { prepareCollectionRemoval } from "../library-edit.js";
import { enabledSkillIds } from "../library-contracts.js";
import { canonicalJson, JsonObject } from "../../shared/json.js";
import { diffCatalogue, diffEnabled, diffInstalledSkills } from "../audit/state-diff.js";
import { decodeCatalogue } from "./catalogue.js";
import { EnabledState, missingEnabledSubject } from "./enabled.js";
import { libraryDatabasePath } from "./database.js";
import {
  loadCatalogueRows,
  loadEnabledRows,
  loadInstalledSkillRows,
  saveCatalogueRows,
  saveEnabledRows,
  saveInstalledSkillRows,
} from "./rows.js";
import { saveCatalogueBase } from "./catalogue-base.js";
import { setupIntent } from "./intent.js";
import {
  advanceLibraryRevision,
  readDatabaseStateRevision,
  saveLibraryHistory,
  saveSetupIntentProgress,
  withLibraryTransaction,
} from "./state-file.js";
import type { HistoryAction } from "./history-action.js";
import type { InstalledSkillsChange } from "./installed.js";

export interface CollectionRemoval extends InstalledSkillsChange {
  readonly removeCollection: CollectionId;
}

const InstalledSkills = Schema.Array(Schema.declare(Schema.is(InstalledSkill))).check(
  Schema.makeFilter(
    (rows) =>
      new Set(rows.map((row) => row.installed_skill_id)).size === rows.length &&
      new Set(rows.map((row) => resolve(row.path))).size === rows.length,
  ),
);

/** Folder work has finished; remove catalogue facts and references with final operation progress. */
export const saveCollectionRemoval = Effect.fn("Library.saveCollectionRemoval")(function* (
  home: string,
  change: CollectionRemoval,
  action: HistoryAction,
) {
  const path = libraryDatabasePath(home);
  return yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      if ((yield* readDatabaseStateRevision(path)).revision !== change.revision)
        return yield* new LibraryChanged({ path });
      const catalogue = yield* decodeCatalogue(path, yield* loadCatalogueRows());
      const installed = yield* loadInstalledSkillRows(path);
      if (canonicalJson(installed) !== canonicalJson(change.installedSkills.base))
        return yield* new LibraryChanged({ path });
      const final = yield* Schema.decodeUnknownEffect(InstalledSkills)(change.installedSkills.next);
      if (!catalogue.collections.some((row) => row.collection_id === change.removeCollection)) {
        // Recovery can reach the already-published side with a still-Pending progress record.
        if (canonicalJson(installed) !== canonicalJson(final))
          return yield* new LibraryChanged({ path });
        return change.revision;
      }
      const selectionRows = yield* loadEnabledRows();
      const selections = yield* Schema.decodeUnknownEffect(EnabledState)(selectionRows);
      const before = { ...selections, ...catalogue };
      const next = prepareCollectionRemoval(before, change.removeCollection);
      const desired = yield* decodeCatalogue(path, next);
      const skills = new Map(desired.skills.map((row) => [row.skill_id, row]));
      const stillInstalled = final.find(
        (row) =>
          !skills
            .get(row.skill_id)
            ?.versions.some((version) => version.skill_version_id === row.skill_version_id),
      );
      if (stillInstalled)
        return yield* new InvalidLibraryState({
          path,
          reason: {
            _tag: "CollectionStillInstalled",
            collectionId: change.removeCollection,
            installedId: stillInstalled.installed_skill_id,
          },
        });
      const collections = new Set(desired.collections.map((row) => row.collection_id));
      const missing = missingEnabledSubject(next, new Set(skills.keys()), collections);
      if (missing) return yield* new InvalidLibraryState({ path, reason: missing });
      const baseDocument = yield* Schema.decodeUnknownEffect(JsonObject)(catalogue);
      const nextDocument = yield* Schema.decodeUnknownEffect(JsonObject)(desired);
      const enabledDocument = yield* Schema.decodeUnknownEffect(JsonObject)(next);
      yield* saveCatalogueBase(path, nextDocument, baseDocument);
      yield* saveEnabledRows(selectionRows, enabledDocument);
      yield* saveCatalogueRows(nextDocument, baseDocument);
      yield* saveInstalledSkillRows(final, installed);
      yield* saveSetupIntentProgress(path, setupIntent(before), setupIntent(next));
      const revision = yield* advanceLibraryRevision(path);
      yield* saveLibraryHistory(path, action, [
        ...diffCatalogue(catalogue, desired),
        ...diffEnabled(
          before,
          next,
          (list) => enabledSkillIds(catalogue, list),
          (list) => enabledSkillIds(desired, list),
        ),
        ...diffInstalledSkills(installed, final),
      ]);
      return revision;
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});
