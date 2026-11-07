import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { basename, dirname, join } from "node:path";
export const writeRawAtomic = Effect.fn("Platform.writeRawAtomic")(function* (
  path: string,
  value: string,
  exclusive = false,
  mode = 0o600,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  yield* Effect.scoped(
    Effect.gen(function* () {
      // Acquire a real directory under the destination parent before starting interruptible
      // output. Even a late native write cannot recreate a file after this scope removes it.
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: dirname(path),
        prefix: `${basename(path)}.tmp-`,
      });
      const temporary = join(directory, "state.json");
      yield* fs.writeFileString(temporary, value, { mode, flag: "wx" });
      // Atomic replacement is the commit point. A delivered interrupt cannot undo it.
      yield* (exclusive ? fs.link(temporary, path) : fs.rename(temporary, path)).pipe(
        Effect.uninterruptible,
      );
    }),
  );
});

export function writeJsonAtomic(
  path: string,
  value: unknown,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return writeRawAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Atomically write a complete identity without replacing an existing file. */
export const writeJsonExclusive = Effect.fn("Platform.writeJsonExclusive")(function* (
  path: string,
  value: unknown,
) {
  yield* writeRawAtomic(path, `${JSON.stringify(value, null, 2)}\n`, true);
});

/**
 * Flush each file or directory in turn: a file's bytes, or a directory's entries so that what was
 * just linked or renamed into it survives a crash.
 */
export const syncPaths = Effect.fn("Platform.syncPaths")(function* (paths: Iterable<string>) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    paths,
    (path) =>
      Effect.scoped(fs.open(path, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync))),
    { discard: true },
  );
});
