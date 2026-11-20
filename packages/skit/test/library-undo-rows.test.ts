import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { SqlClient } from "effect/sql";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import { decodeLibraryState } from "../src/library/library-state.js";
import { makeOperationId, makeImportId } from "../src/library/entity-ids.js";
import * as InstalledSkillStatus from "../src/library/installed-skill-status.js";
import { OperationStatus, type UndoProgram } from "../src/library/store/state-schema.js";
import { prepareLibraryDifference } from "../src/library/store/difference.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import {
  LibraryWriter,
  loadLibrary,
  loadOperation,
  writeLibrary,
} from "../src/library/store/library-store.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-native-undo-" });
  const { state } = yield* fixture;
  yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(state));
  yield* migrateLocalLibraryState(home);
  const pending = OperationStatus.cases.Pending.make({
    operationId: makeOperationId(),
    before: { installedSkills: state.installed_skills },
    steps: [],
    setup: { changes: { scopes: [], sources: [], memberships: [], versions: [] } },
  });
  yield* writeLibrary(
    home,
    Effect.gen(function* () {
      const writer = yield* LibraryWriter;
      yield* writer.recordOperation(
        pending,
        snapshotOf({ present: true, state, revision: yield* writer.revision }),
        "setup",
      );
      yield* writer.settleOperation(pending);
    }),
  );
  const next = yield* decodeLibraryState({
    ...state,
    enabled: [{ skill: state.skills[0]!.skill_id }],
    skills: state.skills.map((skill, index) =>
      index === 1 ? { ...skill, local_version_id: skill.versions.at(-1)!.skill_version_id } : skill,
    ),
    imports: [
      ...state.imports,
      { ...state.imports[0]!, import_id: makeImportId(), imported_at: "2026-11-06T00:00:00.000Z" },
    ],
    installed_skills: state.installed_skills.map((row, index) =>
      index === 0 ? InstalledSkillStatus.pending(row) : row,
    ),
  });
  const program: UndoProgram = {
    operationId: pending.operationId,
    backupId: randomUUID(),
    difference: yield* prepareLibraryDifference(state, next, home),
    files: [],
    paths: [],
    sources: [],
    sourceImports: [],
    actions: [],
    preserve: [],
    preserved: false,
  };
  return { home, path: libraryDatabasePath(home), state, next, program };
});

it.effect(
  "native Undo ignores unrelated scan rows, preserves the Sync base and advances once",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // A whole-Library loader would reject this future cache value. Undo does not own it.
          yield* sql`INSERT INTO library_scan_issues(position,code,path,harness) VALUES(9999,'FUTURE_ISSUE','/unrelated','codex')`;
        }),
      );
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          yield* writer.saveUndo(f.program, f.next, f.state, revision);
          assert.strictEqual(yield* writer.revision, revision + 1);
        }),
      );
      const target = Option.getOrThrow(yield* loadOperation(f.home, f.program.operationId));
      assert.strictEqual(target._tag, "Undone");
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT code FROM library_scan_issues WHERE position=9999`,
            [{ code: "FUTURE_ISSUE" }],
          );
          yield* sql`DELETE FROM library_scan_issues WHERE position=9999`;
        }),
      );
      assert.deepStrictEqual(yield* loadLibrary(f.home), f.next);
      assert.deepStrictEqual((yield* loadLibrary(f.home)).sync_ancestry, f.state.sync_ancestry);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed Installed Skill write rolls back Undo catalogue, scopes, revision and target status",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER fail_undo_installed BEFORE UPDATE ON library_installed_skills BEGIN SELECT RAISE(ABORT,'installed write interrupted'); END`;
        }),
      );
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          const failure = yield* Effect.flip(writer.saveUndo(f.program, f.next, f.state, revision));
          assert.strictEqual(failure._tag, "LibrarySqlError");
          assert.strictEqual(yield* writer.revision, revision);
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* loadOperation(f.home, f.program.operationId))._tag,
        "Done",
      );
      assert.deepStrictEqual(yield* loadLibrary(f.home), f.state);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "native Undo refuses stale revisions and unrelated field changes without settling its target",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          assert.strictEqual(
            (yield* Effect.flip(writer.saveUndo(f.program, f.next, f.state, revision - 1)))._tag,
            "LibraryChanged",
          );
          const invalid = yield* decodeLibraryState({ ...f.next, unknownRoot: { changed: true } });
          assert.strictEqual(
            (yield* Effect.flip(writer.saveUndo(f.program, invalid, f.state, revision)))._tag,
            "InvalidLibraryState",
          );
          assert.strictEqual(yield* writer.revision, revision);
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* loadOperation(f.home, f.program.operationId))._tag,
        "Done",
      );
      assert.deepStrictEqual(yield* loadLibrary(f.home), f.state);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
