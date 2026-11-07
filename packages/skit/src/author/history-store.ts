/** AuthorHistory's private file store. Trees use small manifests over immutable file blobs;
 * earlier byte-bearing tree documents remain readable without rewriting them. */
import { Array, Effect, FileSystem, Option, Order, Path, Schema } from "effect";
import { Digest } from "effect/crypto";
import { Hash, hashHex, sha256Hash } from "../shared/hash.js";
import * as History from "../history/history.js";
import { TreeDirectory, TreeFile, TreeSymlink } from "../artifact/tree-entry.js";
import { syncPaths } from "../platform/atomic-write.js";

const StoredFile = Schema.Struct({
  path: TreeFile.fields.path,
  kind: TreeFile.fields.kind,
  mode: TreeFile.fields.mode,
  blob: Hash,
});
const TreeManifest = Schema.Struct({
  schema: Schema.Literal("skit.author-tree.v1"),
  entries: Schema.Array(Schema.Union([TreeDirectory, StoredFile, TreeSymlink])),
});
const ManifestDocument = Schema.fromJsonString(TreeManifest);
const TreeDocument = Schema.fromJsonString(Schema.toCodecJson(History.Tree));

const storedFolder = (path: Path.Path, directory: string, kind: History.Kind) =>
  path.join(directory, kind === "tree" ? "trees" : "revisions");

export const storedPath = (path: Path.Path, directory: string, kind: History.Kind, hash: Hash) =>
  path.join(storedFolder(path, directory, kind), `${hashHex(hash)}.json`);

/** Publish blobs before their manifest. Neither immutable files nor existing legacy trees are
 * replaced; generic History.Store verifies the reconstructed canonical tree on every read. */
export const makeHistoryStore = Effect.fn("AuthorHistory.makeStore")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digests = yield* Digest.Digest;
  const blobDirectory = path.join(directory, "blobs");
  const blobPath = (hash: Hash) => path.join(blobDirectory, hashHex(hash));
  const hashBytes = (bytes: Uint8Array) =>
    sha256Hash(bytes).pipe(Effect.provideService(Digest.Digest, digests));
  const failed = (cause: unknown) => new History.StoreFailed({ cause });
  const isCorrupt = Schema.is(History.StoreCorrupt);
  const storageError = (cause: unknown) => (isCorrupt(cause) ? cause : failed(cause));
  const corrupt = (hash: Hash, reason: string) =>
    new History.StoreCorrupt({ kind: "tree", hash, reason });
  const flush = (parent: string) =>
    syncPaths([
      parent,
      directory,
      path.dirname(directory),
      path.dirname(path.dirname(directory)),
    ]).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  // Only private storage paths reach this writer. The file is flushed before its exclusive link;
  // callers flush the destination directory before publishing any reference to the file.
  const writeImmutable = Effect.fn("AuthorHistory.writeImmutable")(function* (
    stored: string,
    bytes: Uint8Array,
  ) {
    if (yield* fs.exists(stored)) return;
    const parent = path.dirname(stored);
    yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: parent,
          prefix: ".pending-",
        });
        const temporary = path.join(staging, "document");
        const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(bytes);
        yield* file.sync;
        yield* fs.link(temporary, stored).pipe(
          Effect.uninterruptible,
          Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
        );
      }),
    );
  });
  const readBlob = Effect.fn("AuthorHistory.readBlob")(function* (tree: Hash, blob: Hash) {
    const bytes = yield* fs
      .readFile(blobPath(blob))
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(corrupt(tree, `missing file blob ${blob}`)),
        ),
      );
    if ((yield* hashBytes(bytes)) !== blob)
      return yield* corrupt(tree, `file blob ${blob} does not match its content hash`);
    return bytes;
  });

  return yield* History.makeStore({
    read: (kind, hash) =>
      Effect.gen(function* () {
        const text = yield* fs.readFileString(storedPath(path, directory, kind, hash)).pipe(
          Effect.map(Option.some),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
        );
        if (Option.isNone(text) || kind === "revision") return text;
        // An array is the original canonical document format. Its decoder and identity checks
        // remain History.Store's responsibility, including malformed legacy arrays.
        if (text.value.trimStart().startsWith("[")) return text;
        const manifest = yield* Schema.decodeEffect(ManifestDocument)(text.value).pipe(
          Effect.mapError((error) => corrupt(hash, String(error))),
        );
        const tree = yield* Effect.forEach(manifest.entries, (entry) =>
          Effect.gen(function* () {
            if (entry.kind !== "file") return entry;
            return {
              path: entry.path,
              kind: entry.kind,
              mode: entry.mode,
              bytes: yield* readBlob(hash, entry.blob),
            };
          }),
        );
        return Option.some(yield* Schema.encodeEffect(TreeDocument)(tree));
      }).pipe(Effect.mapError(storageError)),
    write: (kind, hash, text) =>
      Effect.gen(function* () {
        const stored = storedPath(path, directory, kind, hash);
        if (!(yield* fs.exists(stored))) {
          let document = text;
          if (kind === "tree") {
            const tree = yield* Schema.decodeEffect(TreeDocument)(text).pipe(
              Effect.mapError((error) => corrupt(hash, String(error))),
            );
            const blobs = new Set<Hash>();
            const entries = yield* Effect.forEach(tree, (entry) =>
              Effect.gen(function* () {
                if (entry.kind !== "file") return entry;
                const blob = yield* hashBytes(entry.bytes);
                if (!blobs.has(blob)) {
                  yield* writeImmutable(blobPath(blob), entry.bytes);
                  // Refuse an existing corrupt blob before giving a new manifest authority over it.
                  yield* readBlob(hash, blob);
                  blobs.add(blob);
                }
                return { path: entry.path, kind: entry.kind, mode: entry.mode, blob };
              }),
            );
            if (blobs.size > 0) yield* flush(blobDirectory);
            document = yield* Schema.encodeEffect(ManifestDocument)({
              schema: "skit.author-tree.v1",
              entries,
            });
          }
          yield* writeImmutable(stored, new TextEncoder().encode(document));
        }
        // A concurrent writer may have linked the document before flushing its directory. Its
        // referenced blobs were already flushed before that link, so flushing here completes it.
        yield* flush(path.dirname(stored));
      }).pipe(Effect.mapError(storageError)),
    has: (kind, hash) =>
      fs.exists(storedPath(path, directory, kind, hash)).pipe(Effect.mapError(failed)),
    list: (kind) =>
      fs.readDirectory(storedFolder(path, directory, kind)).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.map((names) =>
          Array.sort(
            names
              .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
              .map((name): Hash => `sha256:${name.slice(0, 64)}`),
            Order.String,
          ),
        ),
        Effect.mapError(failed),
      ),
  });
});
