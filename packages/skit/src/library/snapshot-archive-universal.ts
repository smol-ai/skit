import { Crypto, Effect, Schema } from "effect";
import { SnapshotArchive } from "./portable-contracts.js";

const MAX_TREE_BYTES = 32 * 1024 * 1024;
const parentOf = (path: string) =>
  path.lastIndexOf("/") < 0 ? "." : path.slice(0, path.lastIndexOf("/"));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
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

export class SnapshotArchiveInvalid extends Schema.TaggedError<SnapshotArchiveInvalid>()(
  "Library.SnapshotArchiveInvalid",
  { reason: Schema.String },
) {}

const fromBase64 = (value: string) =>
  Effect.try({
    try: () => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
    catch: () => new SnapshotArchiveInvalid({ reason: "invalid file base64" }),
  });

const encodedParts = (parts: readonly (string | Uint8Array)[]): Uint8Array => {
  const encoder = new TextEncoder();
  const chunks = parts.flatMap((part) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    return [encoder.encode(`${bytes.length}:`), bytes, Uint8Array.of(0)];
  });
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/** Decode, validate archive hierarchy, and recompute the verbatim tree digest. */
export const verifySnapshotArchiveEffect = Effect.fn("Library.verifySnapshotArchive")(function* (
  input: unknown,
) {
  const archive = yield* Schema.decodeUnknownEffect(SnapshotArchive)(input).pipe(
    Effect.mapError(() => new SnapshotArchiveInvalid({ reason: "invalid archive shape or path" })),
  );
  const byPath = new Map<string, (typeof archive.entries)[number]>();
  const children = new Map<string, string[]>();
  let treeBytes = 0;
  const decodedFiles = new Map<string, Uint8Array>();
  for (const entry of archive.entries) {
    if (byPath.has(entry.path))
      return yield* new SnapshotArchiveInvalid({ reason: `duplicate path: ${entry.path}` });
    byPath.set(entry.path, entry);
    const parent = parentOf(entry.path);
    const siblings = children.get(parent) ?? [];
    siblings.push(nameOf(entry.path));
    children.set(parent, siblings);
    if (entry.kind === "file") {
      if (entry.content_base64.length > Math.ceil((MAX_TREE_BYTES * 4) / 3) + 4)
        return yield* new SnapshotArchiveInvalid({ reason: "encoded file exceeds byte limit" });
      const bytes = yield* fromBase64(entry.content_base64);
      treeBytes += bytes.length;
      if (treeBytes > MAX_TREE_BYTES)
        return yield* new SnapshotArchiveInvalid({ reason: "tree exceeds byte limit" });
      decodedFiles.set(entry.path, bytes);
    }
    if (entry.kind === "symlink" && !safeLink(entry.path, entry.target))
      return yield* new SnapshotArchiveInvalid({ reason: `unsafe symlink: ${entry.path}` });
  }
  const ordered: (typeof archive.entries)[number][] = [];
  const walk = (parent: string): Effect.Effect<void, SnapshotArchiveInvalid> =>
    Effect.gen(function* () {
      for (const name of (children.get(parent) ?? []).sort()) {
        const path = parent === "." ? name : `${parent}/${name}`;
        const entry = byPath.get(path);
        if (entry === undefined)
          return yield* new SnapshotArchiveInvalid({ reason: `missing path: ${path}` });
        ordered.push(entry);
        if (entry.kind === "directory") yield* walk(path);
        else if (children.has(path))
          return yield* new SnapshotArchiveInvalid({ reason: `child of non-directory: ${path}` });
      }
    });
  yield* walk(".");
  if (ordered.length !== byPath.size)
    return yield* new SnapshotArchiveInvalid({ reason: "missing parent directory" });
  const parts: (string | Uint8Array)[] = [];
  for (const entry of ordered) {
    parts.push(entry.path, entry.kind);
    if (entry.kind === "file") {
      const bytes = decodedFiles.get(entry.path);
      if (bytes === undefined)
        return yield* new SnapshotArchiveInvalid({ reason: `missing file: ${entry.path}` });
      parts.push(String(entry.mode), bytes);
    }
    if (entry.kind === "symlink") parts.push(entry.target);
  }
  const crypto = yield* Crypto.Crypto;
  const actualBytes = yield* crypto.digest("SHA-256", encodedParts(parts));
  const actual = `sha256:${Array.from(actualBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (actual !== archive.digest)
    return yield* new SnapshotArchiveInvalid({ reason: "snapshot digest mismatch" });
  return { archive, entries: ordered, files: decodedFiles };
});
