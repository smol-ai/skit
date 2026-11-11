import { SchemaFailure } from "../shared/schema-issue.js";
import { Effect, Schema } from "effect";
import { encodeHashParts, sha256Hash, Hash } from "../shared/hash.js";
import { SnapshotArchive } from "./library-contracts.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import type { TreeEntry } from "../artifact/tree-entry.js";

const MAX_TREE_BYTES = 32 * 1024 * 1024;
const parentOf = (path: string) =>
  path.lastIndexOf("/") < 0 ? "." : path.slice(0, path.lastIndexOf("/"));
const safeLink = (path: string, target: string): boolean => {
  if (!target || target.startsWith("/") || target.includes("\\") || target.includes("\0"))
    return false;
  const parts = parentOf(path) === "." ? [] : parentOf(path).split("/");
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return false;
      parts.pop();
    } else parts.push(part);
  }
  return true;
};

export const CollectionVersionArchiveInvalidReason = Schema.TaggedUnion({
  InvalidShape: { failure: SchemaFailure },
  InvalidBase64: { path: Schema.String },
  DuplicatePath: { path: Schema.String },
  ByteLimitExceeded: {
    kind: Schema.Literals(["encoded-file", "tree"]),
    path: Schema.String,
    limit: Schema.Int,
    actual: Schema.Int,
  },
  UnsafeSymlink: { path: Schema.String, target: Schema.String },
  ChildOfNonDirectory: { path: Schema.String },
  MissingParent: { unreachable: Schema.Int },
  HashMismatch: {
    kind: Schema.Literals(["archive", "materialized"]),
    expected: Hash,
    actual: Hash,
  },
}).annotate({ identifier: "CollectionVersionArchiveInvalidReason" });
export type CollectionVersionArchiveInvalidReason =
  typeof CollectionVersionArchiveInvalidReason.Type;

export class CollectionVersionArchiveInvalid
  extends Schema.TaggedError<CollectionVersionArchiveInvalid, { readonly brand: unique symbol }>()(
    // Released serialized tag; changing stored/wire spellings is outside this cleanup.
    "Library.SnapshotArchiveInvalid",
    { reason: CollectionVersionArchiveInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

const fromBase64 = (path: string, value: string) =>
  Effect.try({
    try: () => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
    catch: () => new CollectionVersionArchiveInvalid({ reason: { _tag: "InvalidBase64", path } }),
  });

/** Decode, validate archive hierarchy, and recompute the verbatim tree digest. */
export const verifySnapshotArchive = Effect.fn("Library.verifySnapshotArchive")(function* (
  input: unknown,
) {
  const archive = yield* Schema.decodeUnknownEffect(SnapshotArchive)(input).pipe(
    Effect.mapError(
      (error) =>
        new CollectionVersionArchiveInvalid({
          reason: { _tag: "InvalidShape", failure: error },
        }),
    ),
  );
  const paths = new Set<string>();
  const children = new Map<string, TreeEntry[]>();
  let treeBytes = 0;
  for (const entry of archive.entries) {
    if (paths.has(entry.path))
      return yield* new CollectionVersionArchiveInvalid({
        reason: { _tag: "DuplicatePath", path: entry.path },
      });
    paths.add(entry.path);
    let decoded: TreeEntry;
    if (entry.kind === "file") {
      if (entry.content_base64.length > Math.ceil((MAX_TREE_BYTES * 4) / 3) + 4)
        return yield* new CollectionVersionArchiveInvalid({
          reason: {
            _tag: "ByteLimitExceeded",
            kind: "encoded-file",
            path: entry.path,
            limit: Math.ceil((MAX_TREE_BYTES * 4) / 3) + 4,
            actual: entry.content_base64.length,
          },
        });
      const bytes = yield* fromBase64(entry.path, entry.content_base64);
      treeBytes += bytes.length;
      if (treeBytes > MAX_TREE_BYTES)
        return yield* new CollectionVersionArchiveInvalid({
          reason: {
            _tag: "ByteLimitExceeded",
            kind: "tree",
            path: entry.path,
            limit: MAX_TREE_BYTES,
            actual: treeBytes,
          },
        });
      decoded = { path: entry.path, kind: "file", mode: entry.mode, bytes };
    } else decoded = entry;
    if (entry.kind === "symlink" && !safeLink(entry.path, entry.target))
      return yield* new CollectionVersionArchiveInvalid({
        reason: { _tag: "UnsafeSymlink", path: entry.path, target: entry.target },
      });
    const parent = parentOf(entry.path);
    const siblings = children.get(parent) ?? [];
    siblings.push(decoded);
    children.set(parent, siblings);
  }
  const ordered: TreeEntry[] = [];
  const walk = (parent: string): Effect.Effect<void, CollectionVersionArchiveInvalid> =>
    Effect.gen(function* () {
      const siblings = (children.get(parent) ?? []).sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
      for (const entry of siblings) {
        const path = entry.path;
        ordered.push(entry);
        if (entry.kind === "directory") yield* walk(path);
        else if (children.has(path))
          return yield* new CollectionVersionArchiveInvalid({
            reason: { _tag: "ChildOfNonDirectory", path },
          });
      }
    });
  yield* walk(".");
  if (ordered.length !== paths.size)
    return yield* new CollectionVersionArchiveInvalid({
      reason: { _tag: "MissingParent", unreachable: paths.size - ordered.length },
    });
  const parts: (string | Uint8Array)[] = [];
  for (const entry of ordered) {
    parts.push(entry.path, entry.kind);
    if (entry.kind === "file") {
      parts.push(String(entry.mode), entry.bytes);
    }
    if (entry.kind === "symlink") parts.push(entry.target);
  }
  const actual = yield* sha256Hash(encodeHashParts(parts));
  if (actual !== archive.digest)
    return yield* new CollectionVersionArchiveInvalid({
      reason: { _tag: "HashMismatch", kind: "archive", expected: archive.digest, actual },
    });
  return { archive, entries: ordered };
});
