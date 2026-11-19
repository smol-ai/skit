import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { COLLECTION_CONTROL_DIRECTORY } from "../artifact/control-files.js";
import {
  isNormalizedTreeControlPath,
  nativeIdentityOf,
  sameNativeIdentity,
} from "../artifact/tree.js";
import type { TreeFile } from "../artifact/tree-entry.js";
import * as History from "../history/history.js";
import { syncPaths } from "../platform/atomic-write.js";
import { LinkStat } from "../platform/link-stat.js";
import { isCanonicalRelativePath } from "../shared/relative-path.js";
import { LocalFilesChangedDuringSync } from "./failures.js";
import { AuthorWorkspaceUnsafe } from "./workspace-contracts.js";

export const replacementPrefix = "replace-";

const Replacement = Schema.fromJsonString(
  Schema.Struct({ target: Schema.String, before: History.TreeHash }),
);

const savedHash = Effect.fn("AuthorWorkspace.savedFileHash")(function* (
  saved: string,
  target: string,
  info: FileSystem.File.Info,
) {
  const fs = yield* FileSystem.FileSystem;
  if (info.type !== "File") return undefined;
  const bytes = yield* fs.readFile(saved);
  return yield* History.treeHash([
    {
      path: target.normalize("NFC"),
      kind: "file",
      mode: info.mode & 0o111 ? 0o755 : 0o644,
      bytes,
    },
  ]);
});

/** A displaced file survives interruption and is put back without replacing a newer save. */
export const recoverFileReplacement = Effect.fn("AuthorWorkspace.recoverFileReplacement")(
  function* (root: string, directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const links = yield* LinkStat;
    const saved = path.join(directory, "previous");
    const record = path.join(directory, "target.json");
    const unsafe = new AuthorWorkspaceUnsafe({
      path: saved,
      reason: { _tag: "FileReplacementNeedsRecovery" },
    });
    const stat = (file: string) =>
      links
        .lstat(file)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
    const journal = yield* stat(directory);
    if (journal === undefined) return;
    if (journal.type !== "Directory") return yield* unsafe;
    const info = yield* stat(saved);
    if (info !== undefined) {
      if ((yield* stat(record))?.type !== "File") return yield* unsafe;
      const { target, before } = yield* Schema.decodeEffect(Replacement)(
        yield* fs.readFileString(record),
      ).pipe(Effect.mapError(() => unsafe));
      if (!isCanonicalRelativePath(target) || isNormalizedTreeControlPath(target))
        return yield* unsafe;
      const destination = path.join(root, target);
      const parent = path.dirname(destination);
      if (info.type !== "File") return yield* unsafe;
      // Resolve the root's native spelling too. Node can keep the caller's case when
      // resolving the workspace root on a case-insensitive filesystem.
      if ((yield* fs.realPath(root).pipe(Effect.mapError(() => unsafe))) !== root)
        return yield* unsafe;
      const nativeRoot = yield* links.realPathNative(root).pipe(Effect.mapError(() => unsafe));
      const nativeParent = yield* links.realPathNative(parent).pipe(Effect.mapError(() => unsafe));
      if (nativeParent !== path.join(nativeRoot, path.relative(root, parent))) return yield* unsafe;

      const linked = yield* fs.link(saved, destination).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
        Effect.mapError(() => unsafe),
      );
      // An occupied target may be an earlier restoration or a newer save. Only discard
      // the backup if the same inode is already back or the saved bytes are reproducible.
      if (!linked) {
        const current = yield* links.lstat(destination).pipe(Effect.mapError(() => unsafe));
        const restored = Option.getOrElse(
          Option.zipWith(nativeIdentityOf(info), nativeIdentityOf(current), sameNativeIdentity),
          () => false,
        );
        if (!restored && (yield* savedHash(saved, target, info)) !== before) return yield* unsafe;
      }
      yield* syncPaths([saved, parent]).pipe(Effect.mapError(() => unsafe));
      yield* fs.remove(saved);
      yield* syncPaths([directory]);
    }
    yield* fs.remove(directory, { recursive: true });
    yield* syncPaths([path.dirname(directory)]);
  },
);

/**
 * Move first so the inode checked here is the one actually displaced by the write.
 *
 * Saves that reach the target path are kept: one that lands before the check fails the
 * hash, and one that creates a new file at the path makes publication fail. A write
 * through a descriptor still open on the displaced inode after the check is not kept,
 * as with any replacement by name. No retention period could close that window.
 */
export const replaceFile = Effect.fn("AuthorWorkspace.replaceFile")(function* (
  root: string,
  target: string,
  staged: string,
  before: TreeFile,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const links = yield* LinkStat;
  const control = path.join(root, COLLECTION_CONTROL_DIRECTORY);
  const directory = yield* fs.makeTempDirectory({ directory: control, prefix: replacementPrefix });
  const saved = path.join(directory, "previous");
  const record = path.join(directory, "target.json");
  const relative = path.relative(root, target).split(path.sep).join("/");
  const hash = yield* History.treeHash([before]);
  yield* fs.writeFileString(record, JSON.stringify({ target: relative, before: hash }), {
    flag: "wx",
    mode: 0o600,
  });
  // Make the destination of the move discoverable before removing the workspace entry.
  yield* syncPaths([record, directory, control]);

  yield* Effect.gen(function* () {
    yield* fs
      .rename(target, saved)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new LocalFilesChangedDuringSync()),
        ),
      );
    const info = yield* links.lstat(saved);
    if (info.type === "File") yield* syncPaths([saved]);
    yield* syncPaths([directory, path.dirname(target)]);
    if ((yield* savedHash(saved, relative, info)) !== hash)
      return yield* new LocalFilesChangedDuringSync();
    yield* fs
      .link(staged, target)
      .pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () =>
          Effect.fail(new LocalFilesChangedDuringSync()),
        ),
      );
    yield* syncPaths([path.dirname(target)]);
    yield* fs.remove(saved);
    yield* syncPaths([directory]);
    yield* fs.remove(directory, { recursive: true });
    yield* syncPaths([control]);
  }).pipe(
    Effect.catch((error) =>
      recoverFileReplacement(root, directory).pipe(Effect.andThen(Effect.fail(error))),
    ),
    Effect.uninterruptible,
  );
});
