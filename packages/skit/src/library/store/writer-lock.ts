import { Semaphore } from "effect";
import { resolve } from "node:path";
import * as HomeLock from "../../platform/home-lock.js";
import type { Effect } from "effect";
const processSavers = new Map<string, Semaphore.Semaphore>();
const semaphoreFor = (root: string) => {
  let semaphore = processSavers.get(root);
  if (!semaphore) {
    semaphore = Semaphore.makeUnsafe(1);
    processSavers.set(root, semaphore);
  }
  return semaphore;
};
/** Serialize state-file replacements inside the shared home lock. No public write capability. */
export const withLibraryStateReplacement = <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R>,
) => HomeLock.withLock(home, semaphoreFor(resolve(home)).withPermit(program));
