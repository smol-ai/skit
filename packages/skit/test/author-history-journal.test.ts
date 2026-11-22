import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Semaphore, Scope, Exit } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { skitLayer } from "../src/platform/layer.js";
import { lockFile } from "../src/platform/file-lock.js";
import { writeHistoryEvent } from "../src/author/history-journal.js";
import { AuthorWorkspace } from "../src/author/workspace.js";
import { RevisionId } from "../src/history/history.js";
import {
  currentLibraryTransaction,
  libraryDatabasePath,
  withLibraryDatabase,
  withDatabaseTransaction,
} from "../src/library/store/database.js";

const last = RevisionId.make("sha256:" + "3".repeat(64));
const next = RevisionId.make("sha256:" + "4".repeat(64));
const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-journal-" });
  const root = join(home, "workspace");
  return { home, root, path: libraryDatabasePath(home) };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped);
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
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(join(f.home, "history", "journal.sqlite")));
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.strictEqual((yield* sql`SELECT * FROM another_owner`).length, 1);
            assert.strictEqual((yield* sql`SELECT * FROM author_history_events`).length, 1);
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
            [{ sequence: 1 }, { sequence: 2 }],
          );
        }),
        true,
      );
    }),
  ),
);
