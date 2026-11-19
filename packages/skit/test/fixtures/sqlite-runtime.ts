import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { skitLayer } from "../../dist/platform/layer.js";
import { prepareLibraryDatabase, withLibraryDatabase } from "../../dist/library/store/database.js";

const [home, id, mode] = process.argv.slice(2);
if (home === undefined || id === undefined) process.exit(2);
NodeRuntime.runMain(
  Effect.gen(function* () {
    if (mode !== "read") yield* prepareLibraryDatabase(home, true);
    const result = yield* withLibraryDatabase(
      join(home, "library.sqlite"),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (mode !== "read")
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO library_collections (collection_id,label) VALUES (${id},${id})`;
              yield* sql`INSERT INTO library_skills (skill_id,collection_id,path,name) VALUES (${id},${id},'skill','skill')`;
            }),
          );
        const invalid = yield* Effect.result(
          mode === "read"
            ? sql`INSERT INTO library_collections (collection_id,label) VALUES ('blocked','blocked')`
            : sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO library_collections (collection_id,label) VALUES ('rollback','rollback')`;
                  yield* sql`INSERT INTO library_skills (skill_id,collection_id,path,name) VALUES ('invalid','missing','skill','skill')`;
                }),
              ),
        );
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            return {
              rejected: invalid._tag === "Failure",
              collections:
                yield* sql`SELECT collection_id FROM library_collections ORDER BY collection_id`,
              skills: yield* sql`SELECT skill_id FROM library_skills ORDER BY skill_id`,
              integrity: yield* sql`PRAGMA integrity_check`,
              references: yield* sql`PRAGMA foreign_key_check`,
            };
          }),
        );
      }),
      mode === "read",
    );
    process.stdout.write(JSON.stringify(result));
  }).pipe(Effect.provide(skitLayer)),
);
