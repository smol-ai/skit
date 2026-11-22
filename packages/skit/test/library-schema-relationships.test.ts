import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { skitLayer } from "../src/platform/layer.js";
import { saveLibrary } from "./helpers/library-store.js";
import { declaredFixture } from "./helpers/library-values.js";

it.effect(
  "direct SQL keeps historical consent references, rejects wrong ownership and missing trees, and defers imports",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-schema-relationships-" });
      const { state } = yield* declaredFixture;
      yield* saveLibrary(home, state);
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const before = yield* sql`SELECT * FROM library_installed_skills ORDER BY rowid`;
          assert.strictEqual(
            (yield* Effect.result(
              sql`UPDATE library_installed_skills SET skill_version_id=${state.skills[1]!.versions[0]!.skill_version_id} WHERE installed_skill_id=${state.installed_skills[0]!.installed_skill_id}`,
            ))._tag,
            "Failure",
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM library_installed_skills ORDER BY rowid`,
            before,
          );
          yield* sql`UPDATE library_assessment_acceptances SET skill_version_id='absent'`;
          assert.deepStrictEqual(
            yield* sql`SELECT DISTINCT skill_version_id FROM library_assessment_acceptances`,
            [{ skill_version_id: "absent" }],
          );
          for (const reverse of [false, true]) {
            const hash = "sha256:" + (reverse ? "b" : "c").repeat(64);
            const revision = sql`INSERT INTO author_revisions(hash,tree_hash,author_device,author_at,edits_json) VALUES(${hash},${hash},'device',-1,'{}')`;
            assert.strictEqual((yield* Effect.result(revision))._tag, "Failure");
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const tree = sql`INSERT INTO author_trees(hash) VALUES(${hash})`;
                if (reverse) {
                  yield* revision;
                  yield* tree;
                } else {
                  yield* tree;
                  yield* revision;
                }
              }),
            );
          }
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
