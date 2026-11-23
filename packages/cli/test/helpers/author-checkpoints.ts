import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { sqliteLayer } from "@smolai/skit-core/platform";

/** Independent SQL facts for assertions about the persisted state machine. */
export const checkpointStates = (home: string, workspace: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            locator: Schema.String,
            status: Schema.Literals(["Idle", "Sending", "Writing"]),
            base: Schema.NullOr(Schema.String),
            revision: Schema.NullOr(Schema.String),
            from_tree: Schema.NullOr(Schema.String),
            to_tree: Schema.NullOr(Schema.String),
            merged: Schema.NullOr(Schema.Literals([0, 1])),
            next_status: Schema.NullOr(Schema.Literals(["Idle", "Sending"])),
            next_base: Schema.NullOr(Schema.String),
            next_revision: Schema.NullOr(Schema.String),
          }),
        ),
      )(
        yield* sql`SELECT * FROM author_sync_checkpoints WHERE workspace_id=${workspace} ORDER BY locator`,
      );
      return Object.fromEntries(
        rows.map((row) => [
          row.locator,
          {
            _tag: row.status,
            base: row.base,
            ...(row.status === "Sending" ? { revision: row.revision } : {}),
            ...(row.status === "Writing"
              ? {
                  from: row.from_tree,
                  to: row.to_tree,
                  merged: row.merged === 1,
                  next: {
                    _tag: row.next_status,
                    base: row.next_base,
                    ...(row.next_status === "Sending" ? { revision: row.next_revision } : {}),
                  },
                }
              : {}),
          },
        ]),
      );
    }).pipe(
      Effect.provide(sqliteLayer({ filename: join(home, "library.sqlite"), readonly: true })),
      Effect.orDie,
    ),
  );
