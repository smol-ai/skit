import { createHash } from "node:crypto";
import { join, posix, relative, sep } from "node:path";
import { Effect, FileSystem, Result } from "effect";
import { LinkStat } from "@smolai/skit-core";

/** Mirror skills.sh's computedHash byte stream for one Skill folder. */
export const computeSkillsShCompatibleHash = Effect.fn("SkillsSh.computeCompatibleHash")(function* (
  base: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  let readable = true;
  const walk = (current: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const names = yield* Effect.result(fs.readDirectory(current));
      if (Result.isFailure(names)) {
        readable = false;
        return;
      }
      for (const name of names.success) {
        if (name === ".git" || name === "node_modules") continue;
        const path = join(current, name);
        const info = yield* Effect.result(links.lstat(path));
        if (Result.isFailure(info)) {
          readable = false;
          continue;
        }
        if (info.success.type === "Directory") yield* walk(path);
        else if (info.success.type === "File") {
          const bytes = yield* Effect.result(fs.readFile(path));
          if (Result.isFailure(bytes)) readable = false;
          else
            files.push({
              path: relative(base, path).split(sep).join(posix.sep),
              bytes: bytes.success,
            });
        }
      }
    });
  yield* walk(directory);
  if (!readable) return undefined;
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
});
