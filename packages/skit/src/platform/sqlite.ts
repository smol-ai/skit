import type { SqliteClientConfig } from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";

/** One SQL interface and constraint policy, using only this runtime's native driver. */
export const sqliteLayer = (options: SqliteClientConfig) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const { SqliteClient } = yield* process.versions.bun
        ? Effect.promise(() => import("@effect/sql-sqlite-bun"))
        : Effect.promise(() => import("@effect/sql-sqlite-node"));
      // Apple's SQLite cannot open a settled WAL database read-only without sidecars.
      // Open without changing journal mode, then enforce read-only SQL below. Never use
      // immutable=1: another process's committed rows may still be in the WAL.
      // https://github.com/oven-sh/bun/issues/45171
      const sql = yield* SqliteClient.make({
        ...options,
        ...(process.versions.bun && options.readonly
          ? { readonly: false, create: false, disableWAL: true }
          : {}),
      });
      yield* sql`PRAGMA foreign_keys = ON`;
      if (options.readonly) yield* sql`PRAGMA query_only = ON`;
      return sql;
    }),
  ).pipe(
    Layer.provide(Reactivity.layer),
    Layer.provideMerge(
      Layer.succeed(SqlClient.BeginTransaction, options.readonly ? "BEGIN" : "BEGIN IMMEDIATE"),
    ),
  );
