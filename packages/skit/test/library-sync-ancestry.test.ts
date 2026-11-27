import { saveLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import { LibraryWriter, loadLibrary, writeLibrary } from "../src/library/store/library-store.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/database.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { libraryStateRevision } from "../src/library/library-state.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-ancestry-" });
  const { state } = yield* fixture;
  yield* saveLibrary(home, state);
  yield* migrateLocalLibraryState(home);
  const ancestry = { ...state.sync_ancestry!, revision_id: "next-head" };
  return { home, state, ancestry, path: libraryDatabasePath(home) };
});

it.effect(
  "an accepted head initializes an absent Library without inventing local catalogue facts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-absent-" });
      const { state } = yield* fixture;
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.saveSyncAncestry({ expectedBase: null, ancestry: state.sync_ancestry! });
          const loaded = yield* loadLibrary(home);
          assert.deepStrictEqual(loaded.collections, []);
          assert.deepStrictEqual(loaded.skills, []);
          assert.deepStrictEqual(loaded.sync_ancestry, state.sync_ancestry);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepted sync head keeps concurrent local edits and every unrelated field", () =>
  Effect.gen(function* () {
    const { home, state, ancestry } = yield* prepared;
    const beforeAudit = yield* readLibraryAudit(home);
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const revision = yield* writer.revision;
        const edited = {
          ...state,
          collections: state.collections.map((row, i) =>
            i === 0 ? { ...row, label: "edited during request" } : row,
          ),
        };
        yield* writer.saveCatalogue(edited, state, revision);
        const acceptedRevision = yield* writer.revision;
        yield* writer.saveSyncAncestry({ expectedBase: state.sync_ancestry!, ancestry });
        assert.strictEqual(yield* writer.revision, acceptedRevision + 1);
        const after = yield* loadLibrary(home);
        assert.strictEqual(
          libraryStateRevision(after),
          libraryStateRevision({ ...edited, sync_ancestry: ancestry }),
        );
        const audit = yield* readLibraryAudit(home);
        yield* writer.saveSyncAncestry({ expectedBase: null, ancestry });
        assert.strictEqual(yield* writer.revision, acceptedRevision + 1);
        assert.deepStrictEqual(yield* readLibraryAudit(home), audit);
        const stale = yield* Effect.flip(
          writer.saveSyncAncestry({
            expectedBase: state.sync_ancestry!,
            ancestry: { ...ancestry, revision_id: "stale" },
          }),
        );
        assert.strictEqual(stale._tag, "Library.StalePlan");
        assert.strictEqual(
          libraryStateRevision(yield* loadLibrary(home)),
          libraryStateRevision(after),
        );
      }),
    );
    assert.deepStrictEqual(yield* readLibraryAudit(home), beforeAudit);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const phase of ["base", "revision"] as const)
  it.effect(
    `accepted sync head rolls back its header and rows when ${phase} refuses the write`,
    () =>
      Effect.gen(function* () {
        const { home, state, ancestry, path } = yield* prepared;
        yield* withLibraryDatabase(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (phase === "base") {
              yield* sql`CREATE TRIGGER refuse_base BEFORE DELETE ON library_sync_base BEGIN SELECT RAISE(ABORT,'refused'); END`;
              // Ensure the base deletion has a row to touch even when it matches the local manifest.
              yield* sql`INSERT INTO library_sync_base(entity,key,change,value) VALUES('enabled','','changed','[]')`;
            } else
              yield* sql`CREATE TRIGGER refuse_revision BEFORE UPDATE OF revision ON library_device BEGIN SELECT RAISE(ABORT,'refused'); END`;
          }),
        );
        const before = yield* loadLibrary(home);
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const revision = yield* writer.revision;
            const failure = yield* Effect.flip(
              writer.saveSyncAncestry({ expectedBase: before.sync_ancestry!, ancestry }),
            );
            assert.strictEqual(failure._tag, "LibrarySqlError");
            assert.strictEqual(yield* writer.revision, revision);
          }),
        );
        assert.strictEqual(
          libraryStateRevision(yield* loadLibrary(home)),
          libraryStateRevision(before),
        );
        assert.deepStrictEqual((yield* loadLibrary(home)).collections, state.collections);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "accepted sync head is independent of Installed Skill, inventory and security tables",
  () =>
    Effect.gen(function* () {
      const { home, state, ancestry, path } = yield* prepared;
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE library_installed_skills`;
          yield* sql`DROP TABLE library_inventory`;
          yield* sql`DROP TABLE library_assessment_acceptances`;
        }),
      );
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          yield* writer.saveSyncAncestry({ expectedBase: state.sync_ancestry!, ancestry });
          assert.strictEqual(yield* writer.revision, revision + 1);
        }),
      );
      assert.strictEqual((yield* Effect.flip(loadLibrary(home)))._tag, "LibrarySqlError");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an identical receipt cannot hide a missing Library header", () =>
  Effect.gen(function* () {
    const { home, state, path } = yield* prepared;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM library_device`;
      }),
    );
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const failure = yield* Effect.flip(
          writer.saveSyncAncestry({
            expectedBase: state.sync_ancestry!,
            ancestry: state.sync_ancestry!,
          }),
        );
        assert.strictEqual(failure._tag, "InvalidLibraryState");
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
