import { createHash } from "node:crypto";
import { join, posix, relative, sep } from "node:path";
import { Effect, FileSystem, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { LinkStat } from "../../../platform/link-stat.js";

/** Mirror skills.sh's computedHash byte stream for one Skill folder. */
export const inspectSkillsShCompatibleHash = Effect.fn("SkillsSh.inspectCompatibleHash")(function* (
  base: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const failures: PlatformError[] = [];
  const walk = (current: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const names = yield* Effect.result(fs.readDirectory(current));
      if (Result.isFailure(names)) {
        failures.push(names.failure);
        return;
      }
      for (const name of names.success) {
        if (name === ".git" || name === "node_modules") continue;
        const path = join(current, name);
        const info = yield* Effect.result(links.lstat(path));
        if (Result.isFailure(info)) {
          failures.push(info.failure);
          continue;
        }
        if (info.success.type === "Directory") yield* walk(path);
        else if (info.success.type === "File") {
          const bytes = yield* Effect.result(fs.readFile(path));
          if (Result.isFailure(bytes)) failures.push(bytes.failure);
          else
            files.push({
              path: relative(base, path).split(sep).join(posix.sep),
              bytes: bytes.success,
            });
        }
      }
    });
  yield* walk(directory);
  if (failures.length) return Result.fail(failures);
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path);
    hash.update(file.bytes);
  }
  return Result.succeed(hash.digest("hex"));
});

/** Setup treats unreadable bytes as unverifiable, without claiming a mismatch. */
export const computeSkillsShCompatibleHash = Effect.fn("SkillsSh.computeCompatibleHash")(function* (
  base: string,
  directory: string,
) {
  const inspected = yield* inspectSkillsShCompatibleHash(base, directory);
  return Result.isSuccess(inspected) ? inspected.success : undefined;
});
