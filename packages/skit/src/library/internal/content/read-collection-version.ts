import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { TreeDirectory, TreeFile } from "../../../artifact/tree-entry.js";
import { isCollectionControlRootEntry } from "../../../artifact/control-files.js";
import { Hash, hashHex, sha256Hash } from "../../../shared/hash.js";
import { isCanonicalRelativePath, parentDirectories } from "../../../shared/relative-path.js";
import { collectionVersionPath, originalTreeHash } from "../../collection-version.js";
import { InvalidLibraryState, type InvalidLibraryStateReason } from "../../failures.js";

const StoredFile = Schema.Struct({
  path: TreeFile.fields.path,
  kind: TreeFile.fields.kind,
  mode: TreeFile.fields.mode,
  blob: Hash,
});
const Composition = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.library-composition.v1"),
    entries: Schema.Array(Schema.Union([TreeDirectory, StoredFile])),
  }),
);

/** A borrowed read tree. Whole-tree versions keep their existing path; compositions become
 * private copies in the caller's scope. Never persist this result as recovery evidence. */
export const readCollectionVersion = Effect.fn("Library.readCollectionVersion")(function* (
  originalsPath: string,
  hash: Hash,
) {
  const fs = yield* FileSystem.FileSystem;
  const legacy = collectionVersionPath(originalsPath, hash);
  if (yield* fs.exists(legacy)) return legacy;
  const manifestPath = join(originalsPath, "compositions", "trees", `${hashHex(hash)}.json`);
  const invalid = (reason: InvalidLibraryStateReason) =>
    new InvalidLibraryState({ path: manifestPath, reason });
  const text = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
  // Preserve the ordinary missing-whole-tree failure at the caller's read, without writes.
  if (text === undefined) return legacy;
  const manifest = yield* Schema.decodeEffect(Composition)(text).pipe(
    Effect.mapError((error) => invalid({ _tag: "SchemaInvalid", failure: error })),
  );
  const byPath = new Map<string, (typeof manifest.entries)[number]>();
  for (const entry of manifest.entries) {
    const first = entry.path.split("/")[0] ?? "";
    if (
      !isCanonicalRelativePath(entry.path) ||
      byPath.has(entry.path) ||
      first === ".git" ||
      isCollectionControlRootEntry(first, 0)
    )
      return yield* invalid({ _tag: "InvalidData", issue: entry.path });
    byPath.set(entry.path, entry);
  }
  for (const entry of manifest.entries)
    if (parentDirectories(entry.path).some((parent) => byPath.get(parent)?.kind !== "directory"))
      return yield* invalid({ _tag: "InvalidData", issue: entry.path });
  const files = new Map<Hash, Uint8Array>();
  const entries: (typeof TreeDirectory.Type | TreeFile)[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind === "directory") {
      entries.push(entry);
      continue;
    }
    let bytes = files.get(entry.blob);
    if (bytes === undefined) {
      const blob = join(originalsPath, "compositions", "blobs", hashHex(entry.blob));
      bytes = yield* fs
        .readFile(blob)
        .pipe(
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.fail(invalid({ _tag: "ContentMissing", entry: entry.blob })),
          ),
        );
      if ((yield* sha256Hash(bytes)) !== entry.blob)
        return yield* invalid({ _tag: "ContentChanged", entry: entry.blob });
      files.set(entry.blob, bytes);
    }
    entries.push({ path: entry.path, kind: "file", mode: entry.mode, bytes });
  }
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-composition-read-" });
  const ordered = entries.toSorted(
    (left, right) =>
      left.path.split("/").length - right.path.split("/").length ||
      left.path.localeCompare(right.path),
  );
  for (const entry of ordered) {
    const path = join(root, entry.path);
    if (entry.kind === "directory") yield* fs.makeDirectory(path, { mode: 0o700 });
    else {
      // Copies, never hard links: an installed folder or another read cannot change a blob.
      yield* fs.writeFile(path, entry.bytes, { flag: "wx", mode: entry.mode });
    }
  }
  if ((yield* originalTreeHash(root)) !== hash) return yield* invalid({ _tag: "ContentChanged" });
  return root;
});
