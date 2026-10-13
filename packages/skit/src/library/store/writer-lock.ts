import { Context, Deferred, Effect, FileSystem, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { LibraryBusy } from "../../failures.js";
import { writeRawAtomicEffect } from "../../platform/atomic-write.js";

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

/** Writers in this process queue for a Library; the lock file only has to exclude other ones. */
const processWriters = new Map<string, Semaphore.Semaphore>();
/** Every read-compare-write of a Library's state in this process, held or inherited writer alike. */
const processPublishers = new Map<string, Semaphore.Semaphore>();

const semaphoreFor = (semaphores: Map<string, Semaphore.Semaphore>, root: string) => {
  let semaphore = semaphores.get(root);
  if (semaphore === undefined) {
    semaphore = Semaphore.makeUnsafe(1);
    semaphores.set(root, semaphore);
  }
  return semaphore;
};

/**
 * Hold a Library's exclusive writer lock while `program` runs. The lock is never reclaimed
 * automatically: a lock left by a process that died fails closed as `LibraryBusy`, naming the
 * file and its recorded owner so a person can remove it once that owner is confirmed stopped.
 */
export const withLibraryWriterLock = Effect.fn("Library.withWriterLock")(function* <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(home);
  const path = join(root, ".lock");
  const ownership = `${process.pid}@${hostname()} ${randomUUID()}\n`;
  const acquire = Effect.fn("Library.acquireWriterLock")(function* (): Effect.fn.Return<
    void,
    PlatformError | LibraryBusy
  > {
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    // Publish complete ownership atomically, so a contender never reads a half-written owner.
    const attempt = yield* Effect.result(
      writeRawAtomicEffect(path, ownership, true).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );
    if (attempt._tag === "Success") return;
    if (attempt.failure.reason._tag !== "AlreadyExists") return yield* attempt.failure;
    const owner = yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
        ),
      );
    return yield* new LibraryBusy({ path, owner: owner.trim().split(/\s/)[0] || "unrecorded" });
  });
  // Remove only the lock this acquisition wrote. Reading then removing is not one atomic step, so
  // this relies on every writer following the protocol: nothing else removes a live owner's lock.
  const release = fs.readFileString(path).pipe(
    Effect.flatMap((recorded) =>
      recorded === ownership ? fs.remove(path, { force: true }) : Effect.void,
    ),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
    ),
  );
  const exclusive = semaphoreFor(processWriters, root).withPermit(
    Effect.acquireUseRelease(
      acquire().pipe(Effect.map(() => authorityOver(root))),
      (authority) => program.pipe(Effect.provideService(CurrentLibraryWriter, authority)),
      (authority) => endAuthority(authority).pipe(Effect.andThen(release)),
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
 * Hold the writer lock and this process's publish mutex for one replacement of a Library's state.
 * The mutex serializes concurrent fibers that share one inherited writer lock; it is taken inside
 * the lock and never held while acquiring it, so a nested publish cannot deadlock.
 */
export const withLibraryStateReplacement = <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R>,
) =>
  withLibraryWriterLock(home, semaphoreFor(processPublishers, resolve(home)).withPermit(program));
