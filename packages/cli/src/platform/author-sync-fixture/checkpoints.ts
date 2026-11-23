import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { sqliteLayer } from "@smolai/skit-core/platform";

const tables = [
  "author_state_fields",
  "author_workspace_state",
  "author_sync_checkpoints",
  "author_backup_checkpoints",
  "author_inventories",
  "author_inventory_paths",
] as const;
const Row = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Null]));
const Snapshot = Schema.Struct({
  schema: Schema.Literal("fixture.author-checkpoints.v1"),
  tables: Schema.Record(Schema.Literals(tables), Schema.Array(Row)),
});
const Document = Schema.fromJsonString(Snapshot);

/** Development worlds capture only Author's mutable tables; bytes and other owners stay intact. */
export const checkpointStore = (home: string) => {
  const filename = join(home, "library.sqlite");
  return {
    read: Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const entries = yield* Effect.forEach(tables, (table) =>
              Effect.gen(function* () {
                const rows = yield* sql.unsafe(`SELECT * FROM ${table} ORDER BY rowid`);
                return [table, rows] as const;
              }),
            );
            return yield* Schema.encodeEffect(Document)({
              schema: "fixture.author-checkpoints.v1",
              tables: yield* Schema.decodeUnknownEffect(Snapshot.fields.tables)(
                Object.fromEntries(entries),
              ),
            });
          }),
        );
      }).pipe(Effect.provide(sqliteLayer({ filename, readonly: true })), Effect.orDie),
    ),
    corrupt: Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Deliberately damage the declared status column to exercise the owner's decoder.
            yield* sql`PRAGMA ignore_check_constraints=ON`;
            yield* sql`UPDATE author_sync_checkpoints SET status='Unknown'`;
          }),
        );
      }).pipe(Effect.provide(sqliteLayer({ filename }))),
    ),
    write: (text: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const snapshot = yield* Schema.decodeEffect(Document)(text);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const table of [...tables].reverse()) yield* sql.unsafe(`DELETE FROM ${table}`);
              for (const table of tables) {
                const [first, ...rest] = snapshot.tables[table];
                if (first) yield* sql`INSERT INTO ${sql(table)} ${sql.insert([first, ...rest])}`;
              }
            }),
          );
        }).pipe(Effect.provide(sqliteLayer({ filename })), Effect.orDie),
      ),
  };
};
