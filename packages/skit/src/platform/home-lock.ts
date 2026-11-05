import { Context, Deferred, Effect, Exit, FileSystem, Scope, Semaphore, Option } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import { HomeBusy } from "./lock-failures.js";
import { acquireFileLock } from "./file-lock.js";

/**
 * Authority over a held writer lock: the owner's, or a lease of it. Forked fibers inherit it, so
 * reentry takes a lease. An authority stops granting leases when it starts to end and ends only
 * once its leases have, so the owner keeps the lock until every lease is over, and a fiber that
 * arrives after that must acquire the lock itself.
 */
interface WriterAuthority {
  readonly root: string;
  live: boolean;
  leases: number;
  readonly drained: Deferred.Deferred<void>;
}

/** Capability over a held OS lock, provided only while its scope or a nested lease is live. */
class HomeLockLease extends Context.Service<HomeLockLease, WriterAuthority>()(
  "skit/platform/HomeLockLease",
) {}

const authorityOver = (root: string): WriterAuthority => ({
  root,
  live: true,
  leases: 0,
  drained: Deferred.makeUnsafe<void>(),
});

/** Stop granting leases, then wait for those already granted to end. */
const endAuthority = (authority: WriterAuthority) =>
  Effect.suspend(() => {
    authority.live = false;
    return authority.leases === 0 ? Effect.void : Deferred.await(authority.drained);
  });

/** Writers in this process queue for a Library; the home lock only has to exclude other processes. */
const processWriters = new Map<string, Semaphore.Semaphore>();

const semaphoreFor = (semaphores: Map<string, Semaphore.Semaphore>, root: string) => {
  let semaphore = semaphores.get(root);
  if (semaphore === undefined) {
    semaphore = Semaphore.makeUnsafe(1);
    semaphores.set(root, semaphore);
  }
  return semaphore;
};

/**
 * Hold the shared home lock while `program` runs. Library, AuthorHistory and configuration
 * serialize their own writes here; this grants no LibraryWriter. Across processes it
 * is an exclusive SQLite transaction on `<home>/lock.sqlite` (decisions.md A8, D3): the file never
 * holds data and is never unlinked, so the OS releases the lock when its holder exits, even on
 * SIGKILL. It never waits: a lock another process holds fails `HomeBusy` at once. A `.lock` left
 * by an earlier SKIT means nothing and is ignored.
 */
export const withLock = Effect.fn("HomeLock.with")(function* <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | HomeBusy | PlatformError, R | FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(home);
  const path = join(root, "lock.sqlite");
  const acquire = Effect.gen(function* () {
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    const lock = yield* Scope.make();
    yield* acquireFileLock(path).pipe(
      Scope.provide(lock),
      Effect.catchTags({
        FileLockBusy: () => Effect.fail(new HomeBusy({ path })),
        FileLockFailed: (error) =>
          Effect.fail(
            systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "lock",
              pathOrDescriptor: path,
              cause: error.cause,
            }),
          ),
      }),
      Effect.onError(() => Scope.close(lock, Exit.void)),
    );
    return { lock, authority: authorityOver(root) };
  });
  const exclusive = semaphoreFor(processWriters, root).withPermit(
    Effect.acquireUseRelease(
      acquire,
      ({ authority }) => program.pipe(Effect.provideService(HomeLockLease, authority)),
      ({ authority, lock }) =>
        endAuthority(authority).pipe(Effect.andThen(Scope.close(lock, Exit.void))),
    ),
  );
  const current = Option.getOrUndefined(yield* Effect.serviceOption(HomeLockLease));
  if (current?.root !== root) return yield* exclusive;
  return yield* Effect.acquireUseRelease(
    // Checking the authority is live and taking a lease is one step; every exit returns the lease.
    Effect.sync(() => {
      if (!current.live) return undefined;
      current.leases++;
      return authorityOver(root);
    }),
    (lease) =>
      lease === undefined ? exclusive : program.pipe(Effect.provideService(HomeLockLease, lease)),
    (lease) =>
      lease === undefined
        ? Effect.void
        : endAuthority(lease).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                --current.leases === 0 && !current.live
                  ? Deferred.succeed(current.drained, undefined)
                  : Effect.void,
              ),
            ),
          ),
  );
});

export * as HomeLock from "./home-lock.js";
