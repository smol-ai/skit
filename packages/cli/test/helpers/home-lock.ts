import { Effect } from "effect";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Independent native contender: no core lock constructor or writer authority. The database
 * stays empty, and closing the scope releases the OS lock even if taking it failed. */
export const holdHomeLock = Effect.fn("Test.holdHomeLock")(function* (home: string) {
  const database = yield* Effect.acquireRelease(
    Effect.try(() => new DatabaseSync(join(home, "lock.sqlite"))),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.try(() => database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"));
});

/** Whether another holder could take `<home>`'s lock now. */
export const homeLockIsFree = (home: string) => Effect.isSuccess(Effect.scoped(holdHomeLock(home)));
