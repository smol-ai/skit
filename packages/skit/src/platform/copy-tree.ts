import { dirname, join, resolve, sep } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { LinkStat } from "./link-stat.js";
import { TreeError } from "../shared/tree-error.js";

/** Settled namespace operations and scoped handles: no abandoned recursive cp. */
export const copyLocalTreeEffect = Effect.fn("Retention.copyTree")(function* (
  from: string,
  to: string,
  excluded: string | readonly string[] | undefined,
  verbatim: boolean,
): Effect.fn.Return<void, PlatformError | TreeError, FileSystem.FileSystem | LinkStat> {
  const exclusions =
    excluded === undefined ? [] : typeof excluded === "string" ? [excluded] : excluded;
  if (exclusions.some((path) => from === path || from.startsWith(`${path}${sep}`))) return;
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const info = yield* links.lstat(from);
  if (info.type === "Directory") {
    yield* fs.makeDirectory(to, { mode: info.mode }).pipe(Effect.uninterruptible);
    for (const name of yield* fs.readDirectory(from))
      yield* copyLocalTreeEffect(join(from, name), join(to, name), exclusions, verbatim);
    yield* fs.chmod(to, info.mode).pipe(Effect.uninterruptible);
  } else if (info.type === "File") {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fs.open(from);
        const output = yield* fs.open(to, { flag: "wx", mode: info.mode });
        while (true) {
          const bytes = yield* input.readAlloc(64 * 1024);
          if (Option.isNone(bytes)) break;
          yield* output.writeAll(bytes.value);
        }
        yield* fs.chmod(to, info.mode).pipe(Effect.uninterruptible);
      }),
    );
  } else if (info.type === "SymbolicLink") {
    const target = yield* fs.readLink(from);
    yield* fs
      .symlink(verbatim ? target : resolve(dirname(from), target), to)
      .pipe(Effect.uninterruptible);
  } else
    return yield* new TreeError({
      reason: { _tag: "CannotRetain", entryType: info.type, path: from },
    });
});
