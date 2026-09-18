import { Effect, FileSystem } from "effect";

/** Whether a Projection path is on disk. An unreadable path is treated as absent. */
export function existsEffect(path: string): Effect.Effect<boolean, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
  });
}
