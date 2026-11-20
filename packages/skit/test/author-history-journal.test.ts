import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Semaphore, Scope, Exit } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { skitLayer } from "../src/platform/layer.js";
import { lockFile } from "../src/platform/file-lock.js";
import { sqliteLayer } from "../src/platform/sqlite.js";
import { writeHistoryEvent } from "../src/author/history-journal.js";
import { AuthorWorkspace } from "../src/author/workspace.js";
import { RevisionId } from "../src/history/history.js";
import {
  currentLibraryTransaction,
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
  withDatabaseTransaction,
} from "../src/library/store/database.js";

const key = "sha256:" + "1".repeat(64);
const first = RevisionId.make("sha256:" + "2".repeat(64));
const last = RevisionId.make("sha256:" + "3".repeat(64));
const next = RevisionId.make("sha256:" + "4".repeat(64));
const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-journal-" });
  const root = join(home, "workspace");
  yield* fs.makeDirectory(join(home, "history"));
  const source = join(home, "history", "journal.sqlite");
  const events = [first, last].map((revision, index) => ({
    schema: "skit.author-history-event.v1",
    workspace_key: key,
    sequence: index === 0 ? 1 : 3,
    revision,
    root,
  }));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE author_history_workspaces(workspace_key TEXT PRIMARY KEY,workspace_id TEXT UNIQUE,root TEXT NOT NULL)`;
      yield* sql`CREATE TABLE author_history_events(workspace_key TEXT NOT NULL,sequence INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(workspace_key,sequence)) WITHOUT ROWID`;
      yield* sql`INSERT INTO author_history_workspaces VALUES(${key},NULL,${root})`;
      for (const event of events)
        yield* sql`INSERT INTO author_history_events VALUES(${key},${event.sequence},${JSON.stringify(event)})`;
      yield* sql`PRAGMA user_version=1`;
    }).pipe(Effect.provide(sqliteLayer({ filename: source }))),
  );
  return { home, root, source, events, path: libraryDatabasePath(home) };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped);
const sourceRows = (source: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        version: (yield* sql`PRAGMA user_version`)[0],
        events: yield* sql<{
          event_json: string;
        }>`SELECT event_json FROM author_history_events ORDER BY sequence`,
      };
    }).pipe(Effect.provide(sqliteLayer({ filename: source, readonly: true }))),
  );

it.effect(
  "legacy journal rows migrate exactly once, keeping sequence gaps and optional identity presence",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* prepared;
        const writers = yield* Semaphore.make(1);
        const saved = yield* writeHistoryEvent(writers, f.home, f.root, undefined, (latest) => {
          assert.strictEqual(latest, last);
          return Effect.succeed({ id: next });
        });
        assert.strictEqual(saved.id, next);
        const legacy = yield* sourceRows(f.source);
        assert.deepStrictEqual(legacy.version, { user_version: 2 });
        assert.deepStrictEqual(
          legacy.events.map((row) => row.event_json),
          f.events.map((row) => JSON.stringify(row)),
        );
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const events = yield* sql<{
              sequence: number;
              workspace_id: null;
            }>`SELECT sequence,workspace_id FROM author_history_events ORDER BY sequence`;
            assert.deepStrictEqual(
              events.map((row) => row.sequence),
              [1, 3, 4],
            );
            assert.deepStrictEqual(
              events.map((row) => row.workspace_id),
              [null, null, null],
            );
            const columns = yield* sql<{ name: string }>`PRAGMA table_info(author_history_events)`;
            assert.isFalse(
              columns.some((row) => row.name === "event_json" || row.name === "extra"),
            );
          }),
          true,
        );
        yield* writeHistoryEvent(writers, f.home, f.root, undefined, (latest) => {
          assert.strictEqual(latest, next);
          return Effect.succeed({ id: next });
        });
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.strictEqual((yield* sql`SELECT * FROM author_history_events`).length, 3);
          }),
          true,
        );
      }),
    ),
);

it.effect(
  "filesystem work has no shared transaction and another owner can write before the event append",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* prepared;
        yield* writeHistoryEvent(yield* Semaphore.make(1), f.home, f.root, undefined, () =>
          Effect.gen(function* () {
            assert.isUndefined(yield* currentLibraryTransaction(f.home));
            yield* withDatabaseTransaction(
              f.home,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql`CREATE TABLE another_owner(value TEXT NOT NULL)`;
                yield* sql`INSERT INTO another_owner VALUES('written while scan lock is held')`;
              }),
            );
            return { id: next };
          }),
        );
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.strictEqual((yield* sql`SELECT * FROM another_owner`).length, 1);
            assert.strictEqual((yield* sql`SELECT * FROM author_history_events`).length, 3);
          }),
          true,
        );
      }),
    ),
);

it.effect(
  "a failed shared import keeps the fenced source intact and retries without partial rows",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* prepared;
        yield* prepareLibraryDatabase(f.home, true);
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TRIGGER refuse_second BEFORE INSERT ON author_history_events WHEN NEW.sequence=3 BEGIN SELECT RAISE(ABORT,'refused'); END`;
          }),
        );
        const writers = yield* Semaphore.make(1);
        const error = yield* Effect.flip(
          writeHistoryEvent(writers, f.home, f.root, undefined, () => Effect.succeed({ id: last })),
        );
        assert.strictEqual(error._tag, "AuthorHistoryInvalid");
        const legacy = yield* sourceRows(f.source);
        assert.deepStrictEqual(legacy.version, { user_version: 2 });
        assert.deepStrictEqual(
          legacy.events.map((row) => row.event_json),
          f.events.map((row) => JSON.stringify(row)),
        );
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_events`, []);
            assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_workspaces`, []);
            assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_import`, []);
            yield* sql`DROP TRIGGER refuse_second`;
          }),
        );
        yield* writeHistoryEvent(writers, f.home, f.root, undefined, (latest) => {
          assert.strictEqual(latest, last);
          return Effect.succeed({ id: last });
        });
      }),
    ),
);

it.effect("malformed source evidence fails before fencing or inserting native rows", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE author_history_events SET event_json='{' WHERE sequence=3`;
        }).pipe(Effect.provide(sqliteLayer({ filename: f.source }))),
      );
      const error = yield* Effect.flip(
        writeHistoryEvent(yield* Semaphore.make(1), f.home, f.root, undefined, () =>
          Effect.succeed({ id: last }),
        ),
      );
      assert.strictEqual(error._tag, "AuthorHistoryInvalid");
      assert.deepStrictEqual((yield* sourceRows(f.source)).version, { user_version: 1 });
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_events`, []);
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_import`, []);
        }),
        true,
      );
    }),
  ),
);

it.live("Author publication retries a transient Library home writer and appends only once", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* prepared;
      const writers = yield* Semaphore.make(1);
      yield* writeHistoryEvent(writers, f.home, f.root, undefined, () =>
        Effect.succeed({ id: last }),
      );
      const held = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      yield* lockFile(join(f.home, "lock.sqlite")).pipe(Scope.provide(held));
      const fs = yield* FileSystem.FileSystem;
      let attempts = 0;
      let saves = 0;
      const saved = yield* writeHistoryEvent(writers, f.home, f.root, undefined, () => {
        saves++;
        return Effect.succeed({ id: next });
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          chmod: (path, mode) =>
            Effect.gen(function* () {
              yield* fs.chmod(path, mode);
              if (path === join(f.home, "history", "lock.sqlite")) {
                attempts++;
                if (attempts === 2) yield* Scope.close(held, Exit.void);
              }
            }),
        }),
      );
      assert.strictEqual(attempts, 2);
      assert.strictEqual(saves, 1);
      assert.strictEqual(saved.id, next);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT sequence FROM author_history_events ORDER BY sequence`,
            [{ sequence: 1 }, { sequence: 3 }, { sequence: 4 }],
          );
        }),
        true,
      );
    }),
  ),
);

it.effect("unknown journal fields are refused while exact source events remain evidence", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE author_history_events SET event_json=json_set(event_json,'$.future',json('{"kept":[null,false]}'))`;
        }).pipe(Effect.provide(sqliteLayer({ filename: f.source }))),
      );
      const before = (yield* sourceRows(f.source)).events;
      const writers = yield* Semaphore.make(1);
      const result = yield* Effect.result(
        writeHistoryEvent(writers, f.home, f.root, undefined, () => Effect.succeed({ id: next })),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual((yield* sourceRows(f.source)).events, before);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_events`, []);
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_import`, []);
        }),
        true,
      );
    }),
  ),
);
