import { Effect, FileSystem, Option } from "effect";
import { Digest } from "effect/crypto";
import { basename, dirname, join } from "node:path";
import { deterministicTreeHash } from "../artifact/skit.js";
import { LinkStat } from "../platform/link-stat.js";
import { TreeError } from "../shared/tree-error.js";
import type { Hash } from "../shared/hash.js";
import type {
  AbsentEvidence,
  FileIdentity,
  FolderEvidence,
  LinkEvidence,
} from "./store/state-schema.js";

const markerName = ".skit-ownership.json";

/**
 * A folder's or link's exact bytes: every entry's relative path, type and mode, each file's bytes
 * and each link's text, including control files and empty directories. It never follows links,
 * so it identifies the entry wherever it is moved to. Byte-for-byte the hash recovery has always
 * recorded for a moved folder.
 */
export const recoveryFingerprint = Effect.fn("Library.recoveryFingerprint")(function* (
  root: string,
  ownership: "include" | "exclude" = "include",
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(encoder.encode(`${bytes.byteLength}:`), bytes);
  };
  const visit = (
    path: string,
    relative: string,
  ): Effect.Effect<void, TreeError | Effect.Error<ReturnType<typeof fs.readDirectory>>> =>
    Effect.gen(function* () {
      if (ownership === "exclude" && relative === markerName) return;
      const info = yield* links.lstat(path);
      append(JSON.stringify([relative, info.type, info.mode]));
      if (info.type === "SymbolicLink") append(yield* fs.readLink(path));
      else if (info.type === "File") append(yield* fs.readFile(path));
      else if (info.type === "Directory") {
        for (const name of (yield* fs.readDirectory(path)).sort())
          yield* visit(join(path, name), join(relative, name));
      } else return yield* new TreeError({ reason: { _tag: "UnsupportedEntry", path } });
    });
  yield* visit(root, "");
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hex = yield* (yield* Digest.Digest).digestHex(Digest.sha256, bytes);
  return `sha256:${hex}` as const satisfies Hash;
});

/** The lstat of `path`, or none when nothing is there. */
const statAt = Effect.fn("Library.statAt")(function* (path: string) {
  const links = yield* LinkStat;
  return yield* links.identity.lstat(path).pipe(
    Effect.asSome,
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
    ),
  );
});

const readMarker = Effect.fn("Library.readMarker")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(join(path, markerName)).pipe(
    Effect.asSome,
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
    ),
  );
});

/** The physical parent of `path`, as evidence records it. */
const parentOf = Effect.fn("Library.parentOf")(function* (path: string) {
  const links = yield* LinkStat;
  const parent = yield* links.realPathNative(dirname(path));
  const info = yield* links.identity.lstat(parent);
  return { path: parent, dev: info.dev, ino: info.ino } satisfies FileIdentity;
});

/** What is at `path` now, as evidence a later step can check: none when it holds neither kind. */
export const readPathEvidence = Effect.fn("Library.readPathEvidence")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const info = yield* statAt(path);
  if (Option.isNone(info)) return Option.none<FolderEvidence | LinkEvidence>();
  const identity = { path, dev: info.value.dev, ino: info.value.ino };
  const parent = yield* parentOf(path);
  const contentHash = yield* recoveryFingerprint(path);
  if (info.value.type === "Directory")
    return Option.some<FolderEvidence | LinkEvidence>({
      _tag: "Directory",
      ...identity,
      parent,
      contentHash,
      treeHash: yield* deterministicTreeHash(path),
      marker: yield* readMarker(path),
    });
  if (info.value.type === "SymbolicLink")
    return Option.some<FolderEvidence | LinkEvidence>({
      _tag: "SymbolicLink",
      ...identity,
      parent,
      linkTarget: yield* fs.readLink(path),
      canonicalPath: yield* links.realPathNative(path),
      contentHash,
    });
  return Option.none<FolderEvidence | LinkEvidence>();
});

/**
 * Recorded "nothing here" at `path`. Its parent is the nearest folder that exists, which is the
 * physical parent unless setup is about to create the folders between.
 */
export const absentEvidence = Effect.fn("Library.absentEvidence")(function* (path: string) {
  let ancestor = dirname(path);
  while (Option.isNone(yield* statAt(ancestor)) && dirname(ancestor) !== ancestor)
    ancestor = dirname(ancestor);
  const links = yield* LinkStat;
  const physical = yield* links.realPathNative(ancestor);
  const info = yield* links.identity.lstat(physical);
  return {
    _tag: "Absent",
    path,
    parent: { path: physical, dev: info.dev, ino: info.ino },
  } satisfies AbsentEvidence;
});

/** Whether the physical parent of `path` is still the one recorded. */
export const parentIsAsRecorded = Effect.fn("Library.parentIsAsRecorded")(function* (
  path: string,
  parent: FileIdentity,
) {
  const links = yield* LinkStat;
  const physical = yield* links.realPathNative(dirname(path)).pipe(
    Effect.asSome,
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
    ),
  );
  if (Option.isNone(physical) || physical.value !== parent.path) return false;
  const info = yield* statAt(physical.value);
  return (
    Option.isSome(info) &&
    info.value.type === "Directory" &&
    info.value.dev === parent.dev &&
    info.value.ino === parent.ino
  );
});

/**
 * Whether the entry at `at` is exactly the recorded one: the same file (device and inode), the
 * same bytes and, for a folder, the same tree and ownership marker; for a link, the same text.
 * A move keeps all of these, so `at` may be where the entry was moved to.
 */
export const holdsEvidence = Effect.fn("Library.holdsEvidence")(function* (
  evidence: FolderEvidence | LinkEvidence,
  at: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* statAt(at);
  if (
    Option.isNone(info) ||
    info.value.type !== evidence._tag ||
    info.value.dev !== evidence.dev ||
    info.value.ino !== evidence.ino
  )
    return false;
  const content = yield* Effect.result(recoveryFingerprint(at));
  if (content._tag === "Failure" || content.success !== evidence.contentHash) return false;
  if (evidence._tag === "SymbolicLink") return (yield* fs.readLink(at)) === evidence.linkTarget;
  const tree = yield* Effect.result(deterministicTreeHash(at));
  if (tree._tag === "Failure" || tree.success !== evidence.treeHash) return false;
  return Option.makeEquivalence((a: string, b: string) => a === b)(
    yield* readMarker(at),
    evidence.marker,
  );
});

/** Whether nothing is at `path`, under its recorded parent. */
export const absentUnder = Effect.fn("Library.absentUnder")(function* (
  path: string,
  parent: FileIdentity,
) {
  return (yield* parentIsAsRecorded(path, parent)) && Option.isNone(yield* statAt(path));
});

/** Where a removed entry is kept, inside its step's recovery directory. */
export const recoveryEntryPath = (directory: string, index: number, path: string) =>
  join(directory, `${index + 1}-${basename(path)}`);
