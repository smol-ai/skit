import { Effect } from "effect";
import { join } from "node:path";
import { acquireFileLock } from "@smolai/skit-core";

/** Hold `<home>`'s lock until the scope closes, as another SKIT process would. */
export const holdHomeLock = (home: string) => acquireFileLock(join(home, "lock.sqlite"));

/** Whether another holder could take `<home>`'s lock now. */
export const homeLockIsFree = (home: string) => Effect.isSuccess(Effect.scoped(holdHomeLock(home)));
