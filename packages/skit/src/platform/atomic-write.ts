import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { basename, dirname, join } from "node:path";
export const writeRawAtomicEffect = Effect.fn("Library.publishState")(function* (
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
      const directory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: dirname(path), prefix: `${basename(path)}.tmp-` }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const temporary = join(directory, "state.json");
      yield* fs.writeFileString(temporary, value, { mode, flag: "wx" });
      // Atomic replacement is the commit point. A delivered interrupt cannot undo it.
      yield* (exclusive ? fs.link(temporary, path) : fs.rename(temporary, path)).pipe(
        Effect.uninterruptible,
      );
    }),
  );
});

export function writeJsonAtomicEffect(
  path: string,
  value: unknown,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return writeRawAtomicEffect(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Atomically publish a complete identity without replacing an existing file. */
export const writeJsonExclusiveEffect = Effect.fn("Author.publishIdentity")(function* (
  path: string,
  value: unknown,
) {
  yield* writeRawAtomicEffect(path, `${JSON.stringify(value, null, 2)}\n`, true);
});
