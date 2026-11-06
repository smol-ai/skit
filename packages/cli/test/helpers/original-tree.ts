import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { LinkStat } from "@smolai/skit-core/platform";
import { type SnapshotArchive } from "@smolai/skit-core/library";
import { verifySnapshotArchive } from "@smolai/skit-core/universal/consumer";

/** Whole-tree storage layout for independently inspecting or corrupting native test fixtures. */
export function originalTreePath(originals: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(originals, hex.slice(0, 2), hex);
}

/** Inspect every retained entry independently of production tree walking, ignore rules or recovery. */
export const originalArchive = Effect.fn("Test.originalArchive")(function* (
  root: string,
  hash: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const entries: SnapshotArchive["entries"][number][] = [];
  const visit = (directory: string, relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      for (const name of (yield* fs.readDirectory(directory)).sort()) {
        const path = join(directory, name);
        const entryPath = relative ? `${relative}/${name}` : name;
        const info = yield* links.lstat(path);
        if (info.type === "Directory") {
          entries.push({ path: entryPath, kind: "directory" });
          yield* visit(path, entryPath);
        } else if (info.type === "SymbolicLink") {
          entries.push({ path: entryPath, kind: "symlink", target: yield* fs.readLink(path) });
        } else if (info.type === "File") {
          entries.push({
            path: entryPath,
            kind: "file",
            mode: info.mode & 0o111 ? 0o755 : 0o644,
            content_base64: Buffer.from(yield* fs.readFile(path)).toString("base64"),
          });
        } else return yield* Effect.die(`Unsupported fixture entry: ${path}`);
      }
    });
  yield* visit(root, "");
  return (yield* verifySnapshotArchive({ profile: "verbatim/v1", digest: hash, entries })).archive;
});
