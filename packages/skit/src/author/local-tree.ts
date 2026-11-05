import { Effect, Equal, FileSystem, Option, Path, Stream } from "effect";
import * as History from "../history/history.js";
import { LinkStat } from "../platform/link-stat.js";
import { isCanonicalRelativePath } from "../shared/relative-path.js";
import {
  isNormalizedTreeControlPath,
  nativeIdentityOf,
  sameNativeIdentity,
  normalizeAuthorTreeEntries,
  scanAuthorTree,
  type NativeTreeIdentity,
} from "../artifact/tree.js";
import { SkitContractError } from "../api/contracts.js";
import {
  AuthorLocalPathNotObserved,
  AuthorNonNfcPathUnsupported,
  AuthorNormalizationTwin,
  LocalFilesChangedDuringSync,
} from "./failures.js";

/**
 * The workspace's files as author sync sees them: normalized paths, files only, with their
 * modes. Owns the pairing of those bytes with the native entries authorized for this pass.
 * `verbatimHash` is the hash of the snapshot before normalization, as AuthorHistory.capture
 * hashes it, so sync can check that both saw the same files (A14).
 */
export const scanWorkspaceWrite = Effect.fn("AuthorWorkspace.scanWriteTree")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const links = yield* LinkStat;
  const snapshot = yield* scanAuthorTree(root).pipe(
    Effect.mapError((error) =>
      error._tag === "TreeError" && error.reason._tag === "ChangedDuringRead"
        ? new LocalFilesChangedDuringSync()
        : error,
    ),
  );
  // Normalization keeps only files.
  const tree = (yield* normalizeAuthorTreeEntries(snapshot.entries)).flatMap((entry) =>
    entry.kind === "file" ? [entry] : [],
  );
  const contents = new Map(tree.map((entry) => [entry.path, entry.bytes]));
  const targets = new Map(
    [...snapshot.identities].map(
      ([nativePath, identity]) =>
        [nativePath.normalize("NFC"), { ...identity, nativePath }] as const,
    ),
  );
  const stat = (target: string) =>
    links
      .lstat(target)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
  const identityMatches = (info: FileSystem.File.Info, expected: NativeTreeIdentity) =>
    Option.exists(nativeIdentityOf(info), (identity) => sameNativeIdentity(identity, expected));
  const nativePath = (target: string) =>
    links
      .realPathNative(target)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new LocalFilesChangedDuringSync()),
        ),
      );
  const checkTarget = Effect.fn("Sync.checkNativeTarget")(function* (target: string) {
    const parts = target.split("/");
    if (
      target !== target.normalize("NFC") ||
      isNormalizedTreeControlPath(target) ||
      !isCanonicalRelativePath(target)
    )
      return yield* new SkitContractError({
        contract: "Author write target",
        issues: [
          {
            path: target,
            message: "Expected a canonical relative content path outside control directories",
          },
        ],
      });
    let parent = root;
    for (let depth = 0; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      const observed = targets.get(prefix);
      const leaf = depth === parts.length;
      const absolute =
        observed === undefined
          ? path.join(parent, parts[depth - 1] ?? "")
          : path.join(root, observed.nativePath);
      if (observed === undefined && depth > 0) {
        const name = parts[depth - 1];
        const names = yield* fs.readDirectory(parent);
        const twins = names.filter(
          (candidate) => candidate !== name && candidate.normalize("NFC") === name,
        );
        if (twins.length > 0) {
          const canonical = yield* stat(absolute);
          const other = yield* stat(path.join(parent, twins[0] ?? ""));
          const alias =
            twins.length === 1 &&
            !names.includes(name ?? "") &&
            Option.getOrElse(
              Option.zipWith(
                Option.flatMap(Option.fromUndefinedOr(canonical), nativeIdentityOf),
                Option.flatMap(Option.fromUndefinedOr(other), nativeIdentityOf),
                sameNativeIdentity,
              ),
              () => false,
            );
          if (!alias)
            return yield* new AuthorNormalizationTwin({
              path: prefix,
              nativePath: [...parts.slice(0, depth - 1), twins[0] ?? ""].join("/"),
            });
          return yield* new AuthorLocalPathNotObserved({ path: prefix });
        }
      }
      const existing = yield* stat(absolute);
      if (existing === undefined) {
        if (observed !== undefined || depth === 0) return yield* new LocalFilesChangedDuringSync();
        return path.join(absolute, ...parts.slice(depth));
      }
      if (observed !== undefined) {
        if (!identityMatches(existing, observed)) return yield* new LocalFilesChangedDuringSync();
        if (observed.nativePath !== prefix) {
          const canonicalAbsolute = path.join(root, prefix);
          const canonical = yield* stat(canonicalAbsolute);
          if (canonical === undefined)
            return yield* new AuthorNonNfcPathUnsupported({
              path: prefix,
              nativePath: observed.nativePath,
            });
          if (
            !identityMatches(canonical, observed) ||
            (yield* nativePath(absolute)) !== (yield* nativePath(canonicalAbsolute))
          )
            return yield* new AuthorNormalizationTwin({
              path: prefix,
              nativePath: observed.nativePath,
            });
        }
      }
      if (!leaf && existing.type !== "Directory")
        return yield* new AuthorLocalPathNotObserved({ path: prefix || "." });
      if (leaf) {
        const expected = contents.get(target);
        if (observed === undefined || expected === undefined || existing.type !== "File")
          return yield* new AuthorLocalPathNotObserved({ path: target });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(absolute, { flag: "r" });
            if (!identityMatches(yield* file.stat, observed))
              return yield* new LocalFilesChangedDuringSync();
            // Compare what is there now with the bytes sync read, a chunk at a time.
            const read = yield* Stream.fromEffectRepeat(file.readAlloc(64 * 1024)).pipe(
              Stream.takeWhile(Option.isSome),
              Stream.runFold(
                () => ({ length: 0, same: true }),
                (seen, chunk) => ({
                  length: seen.length + chunk.value.length,
                  same:
                    seen.same &&
                    Equal.equals(
                      chunk.value,
                      expected.subarray(seen.length, seen.length + chunk.value.length),
                    ),
                }),
              ),
            );
            const after = yield* stat(absolute);
            if (
              !read.same ||
              read.length !== expected.length ||
              after === undefined ||
              !identityMatches(after, observed)
            )
              return yield* new LocalFilesChangedDuringSync();
          }),
        );
        return absolute;
      }
      parent = absolute;
    }
    return root;
  });
  return { tree, verbatimHash: yield* History.treeHash(snapshot.entries), checkTarget };
});

export interface SyncScan {
  readonly tree: History.Tree;
  readonly verbatimHash: History.TreeHash;
}

/** The passive sync view exposes file facts, never the write owner's target authority. */
export const scanAuthorSyncTree = Effect.fn("Author.scanSyncTree")(function* (root: string) {
  const { tree, verbatimHash } = yield* scanWorkspaceWrite(root);
  const scan: SyncScan = { tree, verbatimHash };
  return scan;
});
