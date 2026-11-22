import { SqlClient, SqlSchema } from "effect/sql";
import { SkillId, SkillVersionId } from "../entity-ids.js";
import { Effect, Schema } from "effect";
import { InstalledSkill } from "../device-state.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { canonicalJson } from "../../shared/json.js";
import { diffInstalledSkills } from "../audit/state-diff.js";
import { libraryDatabasePath, withLibraryDatabase } from "./database.js";
import {
  loadInstalledSkillRow,
  saveInstalledSkillRow,
  loadInstalledSkillRows,
  saveInstalledSkillRows,
} from "./rows.js";
import {
  advanceLibraryRevision,
  readDatabaseStateRevision,
  saveLibraryHistory,
  withLibraryTransaction,
} from "./state-file.js";
import type { HistoryAction } from "./history-action.js";

/** Check the catalogue relationships required by every installed-row publication. */
const checkInstalledSkills = Effect.fn("Library.checkInstalledSkills")(function* (
  path: string,
  rows: readonly InstalledSkill[],
) {
  const sql = yield* SqlClient.SqlClient;
  const findVersions = SqlSchema.findAll({
    Request: Schema.Array(SkillVersionId),
    Result: Schema.Struct({ skill_version_id: SkillVersionId, skill_id: SkillId }),
    execute: (ids) =>
      sql`SELECT v.skill_version_id,v.skill_id FROM library_skill_versions AS v JOIN library_skills AS s ON s.skill_id=v.skill_id WHERE v.skill_version_id IN ${sql.in(ids)}`,
  });
  const ids = [...new Set(rows.map((row) => row.skill_version_id))];
  const owners = new Map<SkillVersionId, SkillId>();
  for (let start = 0; start < ids.length; start += 500)
    for (const row of yield* findVersions(ids.slice(start, start + 500)))
      owners.set(row.skill_version_id, row.skill_id);
  const mismatched = rows.find((row) => owners.get(row.skill_version_id) !== row.skill_id);
  if (mismatched)
    return yield* new InvalidLibraryState({
      path,
      reason: {
        _tag: "InstalledVersionOwnerMismatch",
        installedId: mismatched.installed_skill_id,
        version: mismatched.skill_version_id,
        expectedSkill: mismatched.skill_id,
        actualSkill: owners.get(mismatched.skill_version_id) ?? null,
      },
    });
});

/** Read only the transaction counter; no Library values are loaded or hashed. */
export const loadLibraryRevision = Effect.fn("Library.loadRevision")(function* (home: string) {
  const path = libraryDatabasePath(home);
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const current = yield* readDatabaseStateRevision(path);
      if (current.revision === null) return yield* new LibraryChanged({ path });
      return current.revision;
    }),
    true,
  );
});

/** A status write cannot replace another transaction's intent or another folder's facts. */
export const saveInstalledSkill = Effect.fn("Library.saveInstalledSkill")(function* (
  home: string,
  next: InstalledSkill | undefined,
  base: InstalledSkill | undefined,
  revision: number,
  action: HistoryAction,
) {
  const path = libraryDatabasePath(home);
  const id = next?.installed_skill_id ?? base?.installed_skill_id;
  if (!id || (next && base && next.installed_skill_id !== base.installed_skill_id))
    return yield* new LibraryChanged({ path });
  return yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      if ((yield* readDatabaseStateRevision(path)).revision !== revision)
        return yield* new LibraryChanged({ path });
      const current = yield* loadInstalledSkillRow(path, id);
      if (canonicalJson(current ?? null) !== canonicalJson(base ?? null))
        return yield* new LibraryChanged({ path });
      if (canonicalJson(next ?? null) === canonicalJson(current ?? null)) return revision;
      if (next) yield* checkInstalledSkills(path, [next]);
      yield* saveInstalledSkillRow(path, id, next, current !== undefined);
      const accepted = yield* advanceLibraryRevision(path);
      yield* saveLibraryHistory(
        path,
        action,
        diffInstalledSkills(base ? [base] : [], next ? [next] : []),
      );
      return accepted;
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});

export interface InstalledSkillsChange {
  readonly revision: number;
  readonly installedSkills: {
    readonly next: readonly InstalledSkill[];
    readonly base: readonly InstalledSkill[];
  };
}

/** Final installed rows and operation progress join one transaction owned by the operation store. */
export const saveInstalledSkills = Effect.fn("Library.saveInstalledSkills")(function* (
  home: string,
  change: InstalledSkillsChange,
  action: HistoryAction,
) {
  const path = libraryDatabasePath(home);
  return yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      if ((yield* readDatabaseStateRevision(path)).revision !== change.revision)
        return yield* new LibraryChanged({ path });
      const current = yield* loadInstalledSkillRows(path);
      if (canonicalJson(current) !== canonicalJson(change.installedSkills.base))
        return yield* new LibraryChanged({ path });
      if (canonicalJson(current) === canonicalJson(change.installedSkills.next))
        return change.revision;
      const next = yield* Schema.decodeUnknownEffect(Schema.Array(InstalledSkill), {
        onExcessProperty: "error",
      })(change.installedSkills.next);
      yield* checkInstalledSkills(path, next);
      yield* saveInstalledSkillRows(next, current);
      const accepted = yield* advanceLibraryRevision(path);
      yield* saveLibraryHistory(path, action, diffInstalledSkills(current, next));
      return accepted;
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});

/** Importing a local edit needs the named folder's authority, not all installed folders. */
export const readInstalledSkill = Effect.fn("Library.readInstalledSkill")(function* (
  home: string,
  id: import("../entity-ids.js").InstalledSkillId,
) {
  return yield* withLibraryDatabase(
    libraryDatabasePath(home),
    loadInstalledSkillRow(libraryDatabasePath(home), id),
    true,
  );
});
