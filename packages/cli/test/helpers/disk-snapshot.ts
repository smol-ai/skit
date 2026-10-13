import { assert } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LinkStat } from "@smolai/skit-core";

/**
 * One path exactly as `lstat` sees it. A link records its own target and is never followed. Small
 * files keep their bytes so a diff shows them; larger ones keep a digest.
 */
export type DiskEntry =
  | {
      readonly type: "file";
      readonly mode: number;
      readonly content: string;
      /** Device and inode, recorded only on request: a rewrite of identical bytes changes it. */
      readonly identity?: string;
    }
  | { readonly type: "directory"; readonly mode: number }
  | { readonly type: "symlink"; readonly mode: number; readonly target: string }
  | { readonly type: "other"; readonly mode: number };

/**
 * Every path under the declared roots as `[root, ...segments]`, so any byte of a name survives. A
 * missing root has no entry; an empty one has a directory entry and no children.
 */
export interface DiskSnapshot {
  readonly roots: readonly string[];
  readonly identity?: boolean;
  readonly entries: readonly { readonly path: readonly string[]; readonly entry: DiskEntry }[];
}

export interface DiskDiff {
  readonly created: readonly { readonly path: readonly string[]; readonly after: DiskEntry }[];
  readonly deleted: readonly { readonly path: readonly string[]; readonly before: DiskEntry }[];
  readonly changed: readonly {
    readonly path: readonly string[];
    readonly before: DiskEntry;
    readonly after: DiskEntry;
  }[];
}

export const noDiskChanges: DiskDiff = { created: [], deleted: [], changed: [] };

const INLINE_BYTES = 4096;

/**
 * Read the roots without a loader, a tree hasher, or anything that follows a link: the oracle must
 * not share the exclusions or migrations of the code it checks. With `identity`, each file also
 * records its device and inode, so an atomic rewrite of identical bytes shows as a change; by
 * default only content, mode and type count.
 */
export const captureDisk = Effect.fn("Test.captureDisk")(function* (
  roots: readonly string[],
  options: { readonly identity?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const entries: { path: readonly string[]; entry: DiskEntry }[] = [];
  const visit = Effect.fn("Test.captureDisk.visit")(function* (
    segments: readonly string[],
  ): Effect.fn.Return<void, unknown, FileSystem.FileSystem | LinkStat> {
    const path = join(...segments);
    const observed = yield* Effect.result(links.lstat(path));
    if (observed._tag === "Failure")
      return observed.failure.reason._tag === "NotFound" ? undefined : yield* observed.failure;
    const info = observed.success;
    const mode = info.mode & 0o7777;
    if (info.type === "SymbolicLink")
      entries.push({
        path: segments,
        entry: { type: "symlink", mode, target: yield* fs.readLink(path) },
      });
    else if (info.type === "File") {
      const bytes = Buffer.from(yield* fs.readFile(path));
      entries.push({
        path: segments,
        entry: {
          type: "file",
          mode,
          content:
            bytes.length <= INLINE_BYTES
              ? `base64:${bytes.toString("base64")}`
              : `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          ...(options.identity ? { identity: `${info.dev}:${Option.getOrThrow(info.ino)}` } : {}),
        },
      });
    } else if (info.type === "Directory") {
      entries.push({ path: segments, entry: { type: "directory", mode } });
      for (const name of (yield* fs.readDirectory(path)).sort()) yield* visit([...segments, name]);
    } else entries.push({ path: segments, entry: { type: "other", mode } });
  });
  for (const root of roots) yield* visit([root]);
  return { roots, ...(options.identity ? { identity: true } : {}), entries } satisfies DiskSnapshot;
});

// No name contains NUL, so joining on it keeps every path distinct.
const byPath = (snapshot: DiskSnapshot) =>
  new Map(snapshot.entries.map((item) => [item.path.join("\0"), item] as const));

export const diffDisk = (before: DiskSnapshot, after: DiskSnapshot): DiskDiff => {
  const old = byPath(before);
  const current = byPath(after);
  const paths = [...new Map([...old, ...current]).values()]
    .map((item) => item.path)
    .sort((left, right) => {
      for (let index = 0; index < Math.min(left.length, right.length); index++)
        if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
      return left.length - right.length;
    });
  const created: { path: readonly string[]; after: DiskEntry }[] = [];
  const deleted: { path: readonly string[]; before: DiskEntry }[] = [];
  const changed: { path: readonly string[]; before: DiskEntry; after: DiskEntry }[] = [];
  for (const path of paths) {
    const was = old.get(path.join("\0"))?.entry;
    const is = current.get(path.join("\0"))?.entry;
    if (was === undefined) created.push({ path, after: is! });
    else if (is === undefined) deleted.push({ path, before: was });
    else if (JSON.stringify(was) !== JSON.stringify(is))
      changed.push({ path, before: was, after: is });
  }
  return { created, deleted, changed };
};

/** What changed under the roots `before` declared since it was captured. */
export const diskChanges = (before: DiskSnapshot) =>
  Effect.map(captureDisk(before.roots, { identity: before.identity === true }), (after) =>
    diffDisk(before, after),
  );

/** Every declared root is exactly as it was: no path created, deleted, or changed in any way. */
export const assertDiskUnchanged = (before: DiskSnapshot) =>
  Effect.map(diskChanges(before), (changes) => assert.deepStrictEqual(changes, noDiskChanges));
