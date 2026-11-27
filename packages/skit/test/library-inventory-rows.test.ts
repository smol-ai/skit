import { saveLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import { LibraryWriter, loadLibrary, writeLibrary } from "../src/library/store/library-store.js";
import { readInventoryState } from "../src/library/store/inventory.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/database.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { diffInstalledSkills } from "../src/library/audit/state-diff.js";
import { decodeLibraryState, libraryStateRevision } from "../src/library/library-state.js";
import * as Status from "../src/library/installed-skill-status.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-inventory-rows-" });
  const { state: original } = yield* fixture;
  const first = original.unmanaged[0]!;
  const issue = original.ownershipIssues![0]!;
  const state = yield* decodeLibraryState({
    ...original,
    unmanaged: [
      { ...first, harnesses: ["codex", "codex"] },
      { ...first, paths: [], harnesses: [] },
      {
        harness: "codex",
        path: "/without-aliases",
        currentHash: first.currentHash,
      },
    ],
    ownershipIssues: [
      {
        ...issue,
        harnesses: ["codex", "codex"],
        matchesExpectedHash: false,
      },
      {
        ...issue,
        code: "INVALID_OWNERSHIP_MARKER",
        harnesses: [],
        matchesExpectedHash: true,
        markerReason: { _tag: "NotObject" },
      },
    ],
    scanIssues: [
      ...original.scanIssues!,
      {
        code: "MISSING_ROOT",
        harness: "codex",
        path: "/missing",
      },
      {
        code: "DANGLING_SYMLINK",
        harness: "codex",
        path: "/link",
        target: "/target",
      },
    ],
  });
  yield* saveLibrary(home, state);
  yield* migrateLocalLibraryState(home);
  return { home, state, path: libraryDatabasePath(home) };
});

it.effect(
  "inventory rows preserve duplicate observations, child order, absence and declared diagnostics",
  () =>
    Effect.gen(function* () {
      const { home, state, path } = yield* prepared;
      const loaded = yield* loadLibrary(home);
      assert.strictEqual(libraryStateRevision(loaded), libraryStateRevision(state));
      assert.deepStrictEqual((yield* readInventoryState(home)).value.unmanaged, state.unmanaged);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const columns = yield* sql<{ name: string }>`PRAGMA table_info(library_inventory)`;
          assert.isFalse(
            columns.some(
              (row) =>
                row.name === "unmanaged" ||
                row.name === "ownership_issues" ||
                row.name === "scan_issues",
            ),
          );
          assert.strictEqual((yield* sql`SELECT * FROM library_unmanaged_skills`).length, 3);
          assert.strictEqual((yield* sql`SELECT * FROM library_unmanaged_paths`).length, 2);
          assert.strictEqual((yield* sql`SELECT * FROM library_unmanaged_harnesses`).length, 2);
          assert.strictEqual((yield* sql`SELECT * FROM library_ownership_issues`).length, 2);
          assert.strictEqual((yield* sql`SELECT * FROM library_scan_issues`).length, 4);
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "inventory owner saves status and observations only, preserving all unrelated Library facts",
  () =>
    Effect.gen(function* () {
      const { home, state } = yield* prepared;
      const beforeAudit = yield* readLibraryAudit(home);
      const { scanIssues: _resolved, ...rest } = state;
      const next = {
        ...rest,
        unmanaged: state.unmanaged.slice(1),
        installed_skills: state.installed_skills.map((row, index) =>
          index === 0 ? Status.pending(row) : row,
        ),
      };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          const accepted = yield* writer.saveInventory(next, state, revision);
          assert.strictEqual(accepted, revision + 1);
          assert.strictEqual(yield* writer.saveInventory(next, next, accepted), accepted);
          assert.strictEqual(
            (yield* Effect.flip(writer.saveInventory(state, next, revision)))._tag,
            "LibraryChanged",
          );
          assert.strictEqual(
            (yield* Effect.flip(writer.saveInventory(state, state, accepted)))._tag,
            "LibraryChanged",
          );
          assert.strictEqual(
            (yield* Effect.flip(
              writer.saveInventory(
                {
                  ...next,
                  installed_skills: next.installed_skills.map((row, index) =>
                    index === 0 ? { ...row, path: "/invented/path" } : row,
                  ),
                },
                next,
                accepted,
              ),
            ))._tag,
            "InvalidLibraryState",
          );
        }),
      );
      assert.strictEqual(
        libraryStateRevision(yield* loadLibrary(home)),
        libraryStateRevision(next),
      );
      const audit = yield* readLibraryAudit(home);
      assert.deepStrictEqual(audit.slice(0, beforeAudit.length), beforeAudit);
      assert.deepStrictEqual(
        audit.slice(beforeAudit.length).flatMap((event) => event.changes),
        diffInstalledSkills(state.installed_skills, next.installed_skills),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const refusal of ["audit", "revision"])
  it.effect(
    `a refused ${refusal} rolls back observations, installed status and revision together`,
    () =>
      Effect.gen(function* () {
        const { home, state, path } = yield* prepared;
        const history = yield* readLibraryAudit(home);
        yield* withLibraryDatabase(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (refusal === "audit")
              yield* sql`CREATE TRIGGER refuse_inventory_audit BEFORE INSERT ON library_audit_events BEGIN SELECT RAISE(ABORT,'audit refusal'); END`;
            else
              yield* sql`CREATE TRIGGER refuse_inventory_revision BEFORE UPDATE ON library_device BEGIN SELECT RAISE(ABORT,'revision refusal'); END`;
          }),
        );
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const revision = yield* writer.revision;
            const next = {
              ...state,
              unmanaged: [],
              installed_skills: state.installed_skills.map((row, index) =>
                index === 0 ? Status.pending(row) : row,
              ),
            };
            assert.strictEqual(
              (yield* Effect.flip(writer.saveInventory(next, state, revision)))._tag,
              "LibrarySqlError",
            );
            assert.strictEqual(yield* writer.revision, revision);
          }),
        );
        assert.strictEqual(
          libraryStateRevision(yield* loadLibrary(home)),
          libraryStateRevision(state),
        );
        assert.deepStrictEqual(yield* readLibraryAudit(home), history);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "inventory mutation needs only catalogue FK keys, not catalogue payload, security or ancestry",
  () =>
    Effect.gen(function* () {
      const { home, state, path } = yield* prepared;
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Keep FK metadata and ownership keys; make every catalogue payload column unavailable.
          for (const column of [
            "source_hash",
            "artifact_hash",
            "validation_identity_hash",
            "skill_format",
          ])
            yield* sql`ALTER TABLE library_skill_versions DROP COLUMN ${sql(column)}`;
          yield* sql`DROP TABLE library_assessment_acceptances`;
          yield* sql`DROP TABLE library_collection_version_members`;
          yield* sql`DROP TABLE library_sync_base`;
          yield* sql`DROP TABLE library_sync`;
        }),
      );
      const next = { ...state, unmanaged: [] };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.saveInventory(next, state, yield* writer.revision);
        }),
      );
      assert.deepStrictEqual((yield* readInventoryState(home)).value.unmanaged, []);
      assert.strictEqual((yield* Effect.flip(loadLibrary(home)))._tag, "LibrarySqlError");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unset issue-presence flag cannot hide existing observation rows", () =>
  Effect.gen(function* () {
    const { home, state, path } = yield* prepared;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE library_inventory SET scan_issues_present=0`;
      }),
    );
    const failure = yield* Effect.flip(readInventoryState(home));
    assert.strictEqual(failure._tag, "InvalidLibraryState");
    if (failure._tag === "InvalidLibraryState")
      assert.deepStrictEqual(failure.reason, {
        _tag: "InventoryRowsInvalid",
        table: "library_scan_issues",
      });
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const revision = yield* writer.revision;
        assert.strictEqual(
          (yield* Effect.flip(writer.saveInventory(state, state, revision)))._tag,
          "InvalidLibraryState",
        );
        assert.strictEqual(yield* writer.revision, revision);
      }),
    );
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* sql`SELECT * FROM library_scan_issues`).length, 4);
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
