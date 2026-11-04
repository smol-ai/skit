import { Context, Deferred, Effect, Exit, FileSystem, Scope, Semaphore } from "effect";
import { systemError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import { LibraryBusy } from "../../failures.js";
import { acquireFileLock } from "../../platform/file-lock.js";

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

const CurrentLibraryWriter = Context.Reference<WriterAuthority | undefined>(
  "@smolai/skit/CurrentLibraryWriter",
  { defaultValue: () => undefined },
);

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
/** Every read-compare-write of a Library's state in this process, held or inherited writer alike. */
const processSavers = new Map<string, Semaphore.Semaphore>();

const semaphoreFor = (semaphores: Map<string, Semaphore.Semaphore>, root: string) => {
  let semaphore = semaphores.get(root);
  if (semaphore === undefined) {
    semaphore = Semaphore.makeUnsafe(1);
    semaphores.set(root, semaphore);
  }
  return semaphore;
};

/**
 * Hold a Library's exclusive writer lock, the home lock, while `program` runs. Across processes it
 * is an exclusive SQLite transaction on `<home>/lock.sqlite` (decisions.md A8, D3): the file never
 * holds data and is never unlinked, so the OS releases the lock when its holder exits, even on
 * SIGKILL. It never waits: a lock another process holds fails `LibraryBusy` at once. A `.lock` left
 * by an earlier SKIT means nothing and is ignored.
 */
export const withHomeLock = Effect.fn("HomeLock.with")(function* <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(home);
  const path = join(root, "lock.sqlite");
  const acquire = Effect.gen(function* () {
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    const lock = yield* Scope.make();
    yield* acquireFileLock(path).pipe(
      Scope.provide(lock),
      Effect.catchTags({
        FileLockBusy: () => Effect.fail(new LibraryBusy({ path })),
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
      ({ authority }) => program.pipe(Effect.provideService(CurrentLibraryWriter, authority)),
      ({ authority, lock }) =>
        endAuthority(authority).pipe(Effect.andThen(Scope.close(lock, Exit.void))),
    ),
  );
  const current = yield* CurrentLibraryWriter;
  if (current?.root !== root) return yield* exclusive;
  return yield* Effect.acquireUseRelease(
    // Checking the authority is live and taking a lease is one step; every exit returns the lease.
    Effect.sync(() => {
      if (!current.live) return undefined;
      current.leases++;
      return authorityOver(root);
    }),
    (lease) =>
      lease === undefined
        ? exclusive
        : program.pipe(Effect.provideService(CurrentLibraryWriter, lease)),
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

/**
 * Hold the writer lock and this process's save mutex for one replacement of a Library's state.
 * The mutex serializes concurrent fibers that share one inherited writer lock; it is taken inside
 * the lock and never held while acquiring it, so a nested save cannot deadlock.
 */
export const withLibraryStateReplacement = <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R>,
) => withHomeLock(home, semaphoreFor(processSavers, resolve(home)).withPermit(program));
