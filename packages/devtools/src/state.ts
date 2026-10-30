import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { Configuration, quote, VmError } from "./configuration.ts";

// Same protocol as core's writer lock: publish complete contents with an exclusive hard link.
// Never reclaim automatically: nothing following this protocol removes another live owner's lock.
export const writeAtomic = Effect.fn("VmState.writeAtomic")(function* (
  path: string,
  bytes: string | Uint8Array,
  exclusive = false,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: dirname(path),
        prefix: `${basename(path)}.tmp-`,
      });
      const file = join(temporary, "value");
      yield* typeof bytes === "string"
        ? fs.writeFileString(file, bytes, { mode: 0o600, flag: "wx" })
        : fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      yield* (exclusive ? fs.link(file, path) : fs.rename(file, path)).pipe(Effect.uninterruptible);
    }),
  );
});
export const withLock = <A, E, R>(name: string, program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { root } = yield* Configuration;
    const fs = yield* FileSystem.FileSystem;
    const path = join(root, "locks", `${name}.lock`);
    const owner = `${process.pid}@${hostname()} ${randomUUID()}\n`;
    const acquire = writeAtomic(path, owner, true).pipe(
      Effect.catchTag("PlatformError", (error): Effect.Effect<never, PlatformError | VmError> => {
        if (error.reason._tag !== "AlreadyExists") return Effect.fail(error);
        return fs.readFileString(path).pipe(
          Effect.orElseSucceed(() => "unrecorded"),
          Effect.flatMap((recorded) =>
            Effect.gen(function* () {
              const match = /^(\d+)@(\S+)\s/.exec(recorded);
              const ownerGone =
                match?.[2] === hostname() &&
                (yield* Effect.sync(() => {
                  try {
                    process.kill(Number(match[1]), 0);
                    return false;
                  } catch (failure) {
                    return Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))(failure);
                  }
                }));
              return yield* new VmError({
                message: ownerGone
                  ? `VM lock owner is gone (${recorded.trim()}). After confirming this owner record still matches, remove the stale lock with: rm -- ${quote(path)}`
                  : `VM operation is busy (${recorded.trim()}). Lock: ${path}. Remove it only after confirming its recorded owner has stopped.`,
              });
            }),
          ),
        );
      }),
    );
    const release = fs.readFileString(path).pipe(
      Effect.flatMap((recorded) =>
        recorded === owner ? fs.remove(path, { force: true }) : Effect.void,
      ),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
      ),
    );
    return yield* Effect.acquireUseRelease(
      acquire,
      () => program,
      () => release,
    );
  });
