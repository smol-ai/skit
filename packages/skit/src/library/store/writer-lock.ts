import { Context, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { LibraryBusy } from "../../failures.js";
import { writeRawAtomicEffect } from "../../platform/atomic-write.js";

/** The Library root whose writer lock is held by the current fiber scope. */
export const CurrentLibraryWriterRoot = Context.Reference<string | undefined>(
  "@smolai/skit/CurrentLibraryWriterRoot",
  { defaultValue: () => undefined },
);

export const withLibraryWriterLock = Effect.fn("Library.withWriterLock")(function* <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(home);
  if ((yield* CurrentLibraryWriterRoot) === root) return yield* program;
  const path = join(root, ".lock");
  const acquire = Effect.fn("Library.acquireWriterLock")(function* (): Effect.fn.Return<
    void,
    PlatformError | LibraryBusy
  > {
    // Publish complete ownership atomically. A contender must never observe a created-but-empty
    // lock file and mistake a live writer for stale residue.
    const attempt = yield* Effect.result(
      writeRawAtomicEffect(path, `${process.pid}\n`, true).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );
    if (attempt._tag === "Success") return;
    const error = attempt.failure;
    if (error.reason._tag !== "AlreadyExists") return yield* error;
    const owner = yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchTag("PlatformError", (readError) =>
          readError.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(readError),
        ),
      );
    const pid = /^\d+$/.test(owner.trim()) ? Number(owner.trim()) : undefined;
    // Empty and unparseable locks include locks held by older SKIT versions. Without a PID there
    // is no safe proof that the owner is dead, so fail closed.
    if (pid === undefined || processIsAlive(pid)) return yield* new LibraryBusy({ path });
    const stale = join(root, `.lock-stale-${randomUUID()}`);
    const moved = yield* Effect.result(fs.rename(path, stale));
    if (moved._tag === "Failure") {
      if (moved.failure.reason._tag === "NotFound") return yield* acquire();
      return yield* moved.failure;
    }
    yield* fs.remove(stale, { force: true });
    return yield* acquire();
  });
  return yield* Effect.acquireUseRelease(
    fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(Effect.andThen(acquire())),
    () => program.pipe(Effect.provideService(CurrentLibraryWriterRoot, root)),
    () => fs.remove(path, { force: true }),
  );
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}
