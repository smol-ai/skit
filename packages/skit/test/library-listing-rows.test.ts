import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { openLibrary } from "./helpers/library-store.js";
import { skitLayer } from "../src/platform/layer.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { migrateLibraryDatabase, withLibraryDatabase } from "../src/library/store/database.js";
import { saveDatabaseState } from "../src/library/store/state-file.js";
import { libraryListing } from "../src/library/internal/session/listing.js";

it.effect(
  "relational listing matches captured facts without reading scan, security or sync-base tables",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-listing-rows-" });
      const path = join(home, "library.sqlite");
      const { state } = yield* fixture;
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrateLibraryDatabase(path);
          yield* sql.withTransaction(saveDatabaseState(path, state, null));
        }),
      );
      const library = yield* openLibrary(home);
      const base = snapshotOf({ present: true, state });
      const expected = yield* library.list({ base });
      const expectedSkills = yield* library.skills({ base });
      const expectedLockCollections = libraryListing(
        state,
        join(home, "originals"),
      ).skillsShCollectionIds;
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE library_sync_base`;
          yield* sql`DROP TABLE library_sync`;
          yield* sql`DROP TABLE library_inventory`;
          yield* sql`DROP TABLE library_assessment_acceptances`;
        }),
      );
      assert.deepStrictEqual(yield* library.list(), expected);
      assert.deepStrictEqual(yield* library.skills(), expectedSkills);
      assert.deepStrictEqual(yield* library.installedSkills, expected.installedSkills);
      assert.deepStrictEqual(yield* library.skillsShCollectionIds, expectedLockCollections);
      const document = yield* Effect.result(library.read);
      assert.strictEqual(document._tag, "Failure");
      if (document._tag === "Failure") assert.strictEqual(document.failure._tag, "LibrarySqlError");
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("a listing refuses invalid declared row fields as a typed failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-listing-invalid-" });
    const path = join(home, "library.sqlite");
    const { state } = yield* fixture;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateLibraryDatabase(path);
        yield* sql.withTransaction(saveDatabaseState(path, state, null));
        yield* sql`UPDATE library_collections SET label=''`;
      }),
    );
    const library = yield* openLibrary(home);
    const result = yield* Effect.result(library.list());
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "InvalidLibraryState");
      if (result.failure._tag === "InvalidLibraryState") {
        assert.strictEqual(result.failure.path, path);
        assert.strictEqual(result.failure.reason._tag, "SchemaInvalid");
      }
    }
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
