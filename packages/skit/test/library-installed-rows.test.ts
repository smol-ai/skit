import { writeInventoryV4 } from "./helpers/inventory-v4.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import { LibraryWriter, loadLibrary, writeLibrary } from "../src/library/store/library-store.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { loadInstalledSkillRow } from "../src/library/store/rows.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { saveInstalledSkills } from "../src/library/store/installed.js";
import { canonicalJson } from "../src/shared/json.js";
import {
  makeSkillId,
  makeSkillVersionId,
  makeOperationId,
  makeInstalledSkillId,
} from "../src/library/entity-ids.js";
import { libraryStateRevision } from "../src/library/library-state.js";
import * as Status from "../src/library/installed-skill-status.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-installed-rows-" });
  const { state } = yield* fixture;
  yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(state));
  yield* migrateLocalLibraryState(home);
  const first = state.installed_skills[0];
  if (!first) return yield* Effect.die("Missing Installed Skill");
  return { home, state, first, path: libraryDatabasePath(home) };
});

it.effect(
  "installed progress uses only its row and revision, preserving order, unknown fields and audit",
  () =>
    Effect.gen(function* () {
      const { home, state, first, path } = yield* prepared;
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // A full Library loader or splitter cannot operate after these unrelated tables disappear.
          yield* sql`DROP TABLE library_sync_base`;
          yield* sql`DROP TABLE library_inventory`;
          yield* sql`DROP TABLE library_assessment_acceptances`;
        }),
      );
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const before = yield* writer.revision;
          const pending = Status.pending(first);
          const after = yield* writer.saveInstalledSkill(pending, first, before);
          assert.strictEqual(after, before + 1);
          assert.strictEqual(yield* writer.saveInstalledSkill(pending, pending, after), after);
          const added = {
            ...first,
            installed_skill_id: makeInstalledSkillId(),
            path: first.path + "-second",
          };
          const inserted = yield* writer.saveInstalledSkill(added, undefined, after);
          const removed = yield* writer.saveInstalledSkill(undefined, added, inserted);
          assert.strictEqual(removed, after + 2);
          assert.strictEqual(yield* writer.revision, removed);
          yield* withLibraryDatabase(
            path,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              assert.deepStrictEqual(
                yield* loadInstalledSkillRow(path, first.installed_skill_id),
                pending,
              );
              const rows = yield* sql<{
                installed_skill_id: string;
              }>`SELECT installed_skill_id FROM library_installed_skills ORDER BY rowid`;
              assert.deepStrictEqual(
                rows.map((row) => row.installed_skill_id),
                state.installed_skills.map((row) => row.installed_skill_id),
              );
            }),
            true,
          );
        }),
      );
      const history = yield* readLibraryAudit(home);
      const changes = history.flatMap((event) => event.changes);
      assert.isTrue(
        changes.some(
          (change) => change.id === first.installed_skill_id && change.action === "pending",
        ),
      );
      assert.strictEqual(history.length, 1);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a stale transaction revision refuses an installed write even after the body returns to its old value",
  () =>
    Effect.gen(function* () {
      const { home, state, first } = yield* prepared;
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const before = yield* writer.revision;
          const changed = { ...state, enabled: [{ skill: first.skill_id }] };
          yield* writer.save(changed, state);
          yield* writer.save(state, changed);
          const current = yield* writer.revision;
          assert.strictEqual(current, before + 2);
          const failure = yield* Effect.flip(
            writer.saveInstalledSkill(Status.pending(first), first, before),
          );
          assert.strictEqual(failure._tag, "LibraryChanged");
          const staleRow = yield* Effect.flip(
            writer.saveInstalledSkill(first, Status.pending(first), current),
          );
          assert.strictEqual(staleRow._tag, "LibraryChanged");
          assert.strictEqual(yield* writer.revision, current);
          assert.deepStrictEqual(yield* loadLibrary(home), state);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refused audit writes roll back the installed row and transaction counter together", () =>
  Effect.gen(function* () {
    const { home, state, first, path } = yield* prepared;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_installed_audit BEFORE INSERT ON library_audit_events BEGIN SELECT RAISE(ABORT,'audit fixture refusal'); END`;
      }),
    );
    const history = yield* readLibraryAudit(home);
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const before = yield* writer.revision;
        const failure = yield* Effect.flip(
          writer.saveInstalledSkill(Status.pending(first), first, before),
        );
        assert.strictEqual(failure._tag, "LibrarySqlError");
        assert.strictEqual(yield* writer.revision, before);
      }),
    );
    assert.deepStrictEqual(yield* loadLibrary(home), state);
    assert.deepStrictEqual(yield* readLibraryAudit(home), history);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "upgrades the existing database to native revisions without changing Library values",
  () =>
    Effect.gen(function* () {
      const { home, state, path } = yield* prepared;
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Recreate the previous branch's exact header and inventory layout.
          yield* writeInventoryV4(state);
          yield* sql`ALTER TABLE library_device ADD COLUMN state_hash TEXT NOT NULL DEFAULT ''`;
          yield* sql`UPDATE library_device SET state_hash=${libraryStateRevision(state)}`;
          yield* sql`ALTER TABLE library_device DROP COLUMN revision`;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id=4`;
        }),
      );
      yield* migrateLocalLibraryState(home);
      assert.deepStrictEqual(yield* loadLibrary(home), state);
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          assert.strictEqual(yield* (yield* LibraryWriter).revision, 0);
        }),
      );
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const columns = yield* sql<{ name: string }>`PRAGMA table_info(library_device)`;
          assert.isFalse(columns.some((column) => column.name === "state_hash"));
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const invalid of ["missing-skill", "missing-version", "wrong-owner"] as const)
  for (const bulk of [false, true])
    it.effect(
      `installed ${bulk ? "bulk" : "single"} publication rejects ${invalid} atomically`,
      () =>
        Effect.gen(function* () {
          const { home, state, first } = yield* prepared;
          const next = {
            ...first,
            ...(invalid === "missing-skill"
              ? { skill_id: makeSkillId() }
              : {
                  skill_version_id:
                    invalid === "missing-version"
                      ? makeSkillVersionId()
                      : state.installed_skills[1]!.skill_version_id,
                }),
          };
          const audit = yield* readLibraryAudit(home);
          yield* writeLibrary(
            home,
            Effect.gen(function* () {
              const writer = yield* LibraryWriter;
              const revision = yield* writer.revision;
              const failure = yield* Effect.flip(
                bulk
                  ? saveInstalledSkills(
                      home,
                      {
                        revision,
                        installedSkills: {
                          base: state.installed_skills,
                          next: [next, ...state.installed_skills.slice(1)],
                        },
                      },
                      {
                        eventId: makeOperationId(),
                        occurredAt: "2026-11-19T00:00:00.000Z",
                        workflow: "test",
                      },
                    )
                  : writer.saveInstalledSkill(next, first, revision),
              );
              assert.strictEqual(failure._tag, "InvalidLibraryState");
              assert.strictEqual(yield* writer.revision, revision);
            }),
          );
          assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(state));
          assert.deepStrictEqual(yield* readLibraryAudit(home), audit);
        }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );

it.effect("installed path swaps keep valid rows, order and extension fields", () =>
  Effect.gen(function* () {
    const { home, state } = yield* prepared;
    const rows = state.installed_skills.map((row) => ({ ...row }));
    [rows[0]!.path, rows[1]!.path] = [rows[1]!.path, rows[0]!.path];
    const next = { ...state, installed_skills: rows };
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        yield* writer.save(next, state, yield* writer.revision);
      }),
    );
    assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(next));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a failed path swap rolls back rows, revision and audit together", () =>
  Effect.gen(function* () {
    const { home, state, path } = yield* prepared;
    const rows = state.installed_skills.map((row) => ({ ...row }));
    [rows[0]!.path, rows[1]!.path] = [rows[1]!.path, rows[0]!.path];
    const audit = yield* readLibraryAudit(home);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_swapped_row BEFORE INSERT ON library_installed_skills WHEN NEW.path='/device/skills/0' BEGIN SELECT RAISE(ABORT,'swap refused'); END`;
      }),
    );
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const revision = yield* writer.revision;
        assert.strictEqual(
          (yield* Effect.flip(writer.save({ ...state, installed_skills: rows }, state, revision)))
            ._tag,
          "LibrarySqlError",
        );
        assert.strictEqual(yield* writer.revision, revision);
      }),
    );
    assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(state));
    assert.deepStrictEqual(yield* readLibraryAudit(home), audit);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("bulk publication rejects a remaining orphan but permits removing it", () =>
  Effect.gen(function* () {
    const { home, state, first, path } = yield* prepared;
    const orphan = { ...first, skill_id: makeSkillId() };
    // Model a database produced by the former unchecked single-row writer.
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys=OFF`;
        yield* sql`UPDATE library_installed_skills SET skill_id=${orphan.skill_id} WHERE installed_skill_id=${first.installed_skill_id}`;
        yield* sql`PRAGMA foreign_keys=ON`;
      }),
    );
    const base = [orphan, ...state.installed_skills.slice(1)];
    const next = base.map((row, index) =>
      index === 1 ? { ...row, status: "pending" as const } : row,
    );
    const audit = yield* readLibraryAudit(home);
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const revision = yield* writer.revision;
        const action = {
          eventId: makeOperationId(),
          occurredAt: "2026-11-19T00:00:00.000Z",
          workflow: "test",
        };
        const error = yield* Effect.flip(
          saveInstalledSkills(home, { revision, installedSkills: { base, next } }, action),
        );
        assert.strictEqual(error._tag, "InvalidLibraryState");
        assert.strictEqual(yield* writer.revision, revision);
        assert.deepStrictEqual(yield* readLibraryAudit(home), audit);
        const accepted = yield* saveInstalledSkills(
          home,
          { revision, installedSkills: { base, next: next.slice(1) } },
          action,
        );
        assert.strictEqual(accepted, revision + 1);
      }),
    );
    assert.strictEqual(
      canonicalJson(yield* loadLibrary(home)),
      canonicalJson({ ...state, installed_skills: next.slice(1) }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
