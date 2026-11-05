import { Effect, FileSystem, Path, Schema } from "effect";
import { COLLECTION_CONTROL_DIRECTORY } from "../artifact/control-files.js";
import * as History from "../history/history.js";
import { LinkStat } from "../platform/link-stat.js";
import { SkitContractError } from "../protocol/api-contracts.js";
import { TreeEntry } from "../artifact/tree-entry.js";
import { syncPaths } from "../platform/atomic-write.js";
import { LocalFilesChangedDuringSync } from "./failures.js";
import { scanWorkspaceWrite } from "./local-tree.js";

/**
 * The file half of WorkspaceLease.writeTree, after the lease has checked its PreparedWrite: make
 * the workspace's files `to`, if they are still `from`. Only files are written: a directory or
 * symlink in a SKIT is refused rather than dropped.
 *
 * Staged under <root>/.skit/stage-*, on the targets' filesystem, so each rename stays on one
 * mount; EXDEV from a nested mount is reported, never copied around. Every written file and every
 * directory whose entries changed is flushed before this returns (decisions.md A13). A stage
 * folder left by a crash is removed at the next acquire.
 */
export const writeWorkspaceTree = Effect.fn("AuthorWorkspace.writeTree")(function* (
  root: string,
  from: History.Tree,
  to: History.Tree,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const links = yield* LinkStat;
  const local = yield* scanWorkspaceWrite(root);
  if ((yield* History.treeHash(local.tree)) !== (yield* History.treeHash(from)))
    return yield* new LocalFilesChangedDuringSync();
  const before = new Map(
    from.flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry] as const] : [])),
  );
  const files = to.flatMap((entry) => (entry.kind === "file" ? [entry] : []));
  const unsupported = to.find((entry) => entry.kind !== "file");
  if (unsupported !== undefined)
    return yield* new SkitContractError({
      contract: "Author sync tree",
      issues: [
        {
          path: unsupported.path,
          message: `Author sync writes files only; the SKIT holds a ${unsupported.kind} here`,
        },
      ],
    });
  const changed = files.filter((entry) => {
    const was = before.get(entry.path);
    return was === undefined || !Schema.toEquivalence(TreeEntry)(was, entry);
  });
  const kept = new Set(files.map((entry) => entry.path));
  const removed = [...before.keys()].filter((target) => !kept.has(target));
  // Directories whose entries this write changes, flushed once at the end.
  const touched = new Set<string>();
  // Check every target before writing any.
  for (const entry of changed) yield* local.checkTarget(entry.path);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: path.join(root, COLLECTION_CONTROL_DIRECTORY),
        prefix: "stage-",
      });
      for (const entry of changed) {
        const staged = path.join(staging, ...entry.path.split("/"));
        yield* fs.makeDirectory(path.dirname(staged), { recursive: true });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(staged, { flag: "wx", mode: entry.mode });
            yield* file.writeAll(entry.bytes);
            yield* fs.chmod(staged, entry.mode);
            yield* file.sync;
          }),
        );
      }
      for (const entry of changed) {
        const absolute = yield* local.checkTarget(entry.path);
        yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
        const target = yield* local.checkTarget(entry.path);
        yield* fs.rename(path.join(staging, ...entry.path.split("/")), target);
        // The rename changed its folder, and any folder it created changed its parent.
        for (
          let folder = path.dirname(target);
          folder !== root && folder.startsWith(root);
          folder = path.dirname(folder)
        )
          touched.add(folder);
        touched.add(root);
      }
    }),
  );
  for (const target of removed) {
    const absolute = yield* local.checkTarget(target);
    yield* fs.remove(absolute);
    touched.add(path.dirname(absolute));
  }
  // Remove the folders those deletions emptied, deepest first. Each held a removed file, so none
  // was empty before; one that still holds anything, ignored files included, stays.
  const folders = [
    ...new Set(
      removed.flatMap((target) =>
        target
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
      ),
    ),
  ].sort((left, right) => right.split("/").length - left.split("/").length);
  for (const folder of folders) {
    const absolute = path.join(root, ...folder.split("/"));
    if (yield* links.removeEmptyDirectory(absolute)) {
      touched.delete(absolute);
      touched.add(path.dirname(absolute));
    }
  }
  // A folder named natively by one removal may be gone by its canonical name after another.
  const remaining: string[] = [];
  for (const folder of touched) if (yield* fs.exists(folder)) remaining.push(folder);
  yield* syncPaths(remaining);
});
