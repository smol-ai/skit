import { Effect, FileSystem, Schema, Struct } from "effect";
import { SqlClient } from "effect/sql";
import { emptyLibraryState } from "../library-state.js";
import { LibraryStateFields } from "./state-fields.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { canonicalJson, JsonObject } from "../../shared/json.js";
import { diffInstalledSkills } from "../audit/state-diff.js";
import { libraryDatabasePath, withLibraryDatabase } from "../database.js";
import { loadInventoryRows, saveInventoryRows, decodeInventoryScan } from "./inventory-rows.js";
import { loadInstalledSkillRows, saveInstalledSkillRows } from "./rows.js";
import {
  advanceLibraryRevision,
  readDatabaseStateRevision,
  saveDatabaseState,
  saveLibraryHistory,
  withLibraryTransaction,
} from "./state-file.js";
import type { HistoryAction } from "./history-action.js";

const fields = ["unmanaged", "ownershipIssues", "scanIssues", "installed_skills"] as const;
const InventoryFields = Schema.Struct(Struct.pick(LibraryStateFields, fields));
export type InventoryState = typeof InventoryFields.Type;
const InventoryState = InventoryFields;
const decodeInventoryState = Effect.fn("Inventory.decodeState")(function* (
  path: string,
  input: InventoryState,
) {
  // Diagnostic evidence has the same JSON representation as the released document boundary.
  const text = yield* Effect.try({
    try: () => JSON.stringify(Struct.pick(input, fields)),
    catch: () =>
      new InvalidLibraryState({
        path,
        reason: { _tag: "DocumentEncodingFailed", document: "inventory" },
      }),
  });
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(text);
  return yield* Schema.decodeUnknownEffect(InventoryState, { onExcessProperty: "error" })(value);
});

/** One snapshot of the scan and installed rows, without catalogue or ancestry reads. */
export const readInventoryState = Effect.fn("Inventory.readState")(function* (home: string) {
  const path = libraryDatabasePath(home);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path)))
    return { revision: null, value: Struct.pick(emptyLibraryState(), fields) };
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const { revision } = yield* readDatabaseStateRevision(path);
          const scan = yield* loadInventoryRows(path);
          const installed = yield* loadInstalledSkillRows(path);
          if (revision === null && (scan !== undefined || installed.length))
            return yield* new InvalidLibraryState({
              path,
              reason: { _tag: "ContentMissing", entry: "library_device" },
            });
          return {
            revision,
            value: { ...(scan ?? { unmanaged: [] }), installed_skills: installed },
          };
        }),
      );
    }),
    true,
  ).pipe(
    Effect.catchTag("SchemaError", (failure) =>
      Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
    ),
  );
});

/** Scan results and Installed Skill status are one owner mutation; scanning stays outside it. */
export const saveInventory = Effect.fn("Inventory.save")(function* (
  home: string,
  nextInput: InventoryState,
  baseInput: InventoryState,
  revision: number | null,
  action: HistoryAction,
) {
  const path = libraryDatabasePath(home);
  return yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      if ((yield* readDatabaseStateRevision(path)).revision !== revision)
        return yield* new LibraryChanged({ path });
      const next = yield* decodeInventoryState(path, nextInput);
      const base = yield* decodeInventoryState(path, baseInput);
      const scan = yield* loadInventoryRows(path);
      const installed = yield* loadInstalledSkillRows(path);
      const current = { ...(scan ?? { unmanaged: [] }), installed_skills: installed };
      if (canonicalJson(current) !== canonicalJson(base))
        return yield* new LibraryChanged({ path });
      const unchanged = canonicalJson(current) === canonicalJson(next);
      if (unchanged && revision !== null) return revision;
      // Refresh may change status evidence, never the identity, provenance or order of installed copies.
      const identity = (row: InventoryState["installed_skills"][number]) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([field]) =>
              ![
                "status",
                "current_hash",
                "conflicts",
                "suppression_reason",
                "suppressed_at",
              ].includes(field),
          ),
        );
      const changedRow = next.installed_skills.find((row, index) => {
        const prior = installed[index];
        return (
          prior === undefined || canonicalJson(identity(row)) !== canonicalJson(identity(prior))
        );
      });
      if (next.installed_skills.length !== installed.length || changedRow !== undefined)
        return yield* new InvalidLibraryState({
          path,
          reason: {
            _tag: "InventoryInstalledIdentityChanged",
            expectedCount: installed.length,
            actualCount: next.installed_skills.length,
            ...(changedRow === undefined ? {} : { installedId: changedRow.installed_skill_id }),
          },
        });
      if (revision === null) yield* saveDatabaseState(path, emptyLibraryState(), null);
      if (!unchanged) {
        yield* saveInventoryRows(yield* decodeInventoryScan(next), scan);
        yield* saveInstalledSkillRows(next.installed_skills, installed);
        yield* saveLibraryHistory(
          path,
          action,
          diffInstalledSkills(installed, next.installed_skills),
        );
        return yield* advanceLibraryRevision(path);
      }
      const saved = yield* readDatabaseStateRevision(path);
      if (saved.revision === null) return yield* new LibraryChanged({ path });
      return saved.revision;
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});
