/** AuthorHistory owns relational metadata, immutable file bytes and recovery evidence. */
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { JsonObject } from "../shared/json.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
  withDatabaseTransaction,
} from "../library/store/database.js";
import {
  hasHistoryRows,
  knownHistoryRows,
  listHistoryRows,
  loadTreeRows,
  loadRevisionRows,
  saveTreeRows,
  saveRevisionRows,
  type StoredEntry,
  type StoredRevision,
} from "./history-rows.js";
import { Digest } from "effect/crypto";
import { Hash, hashHex } from "../shared/hash.js";
import * as History from "../history/history.js";
import { TreeDirectory, TreeFile, TreeSymlink } from "../artifact/tree-entry.js";
import { syncPaths } from "../platform/atomic-write.js";
import { makeFileBytes, FileBytesInvalid } from "../artifact/file-bytes.js";

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

export const makeHistoryStore = Effect.fn("AuthorHistory.makeStore")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digests = yield* Digest.Digest;
  const home = path.dirname(directory);
  const database = libraryDatabasePath(home);
  const bytes = yield* makeFileBytes(home);
  const recoveryDirectory = path.join(directory, "recovery", "trees");
  let prepared = false;
  const failed = (cause: unknown) => new History.StoreFailed({ cause });
  const isCorrupt = Schema.is(History.StoreCorrupt);
  const storageError = (cause: unknown) => (isCorrupt(cause) ? cause : failed(cause));
  const corrupt = (hash: Hash, reason: History.StoreCorruptReason) =>
    new History.StoreCorrupt({ kind: "tree", hash, reason });
  const flush = (parent: string) =>
    syncPaths([
      parent,
      path.dirname(parent),
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
  const byteFailure = (tree: Hash, error: FileBytesInvalid) =>
    error.reason._tag === "Missing"
      ? corrupt(tree, { _tag: "BlobMissing", blob: error.hash })
      : error.reason._tag === "HashMismatch"
        ? corrupt(tree, { _tag: "BlobHashMismatch", blob: error.hash, actual: error.reason.actual })
        : failed(error);
  const readBlobs = (tree: Hash, blobs: readonly Hash[]) =>
    bytes
      .readMany(blobs)
      .pipe(Effect.catchTag("FileBytesInvalid", (error) => Effect.fail(byteFailure(tree, error))));
  const provideStorage = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Digest.Digest>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Digest.Digest, digests),
    );
  const readRows = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    provideStorage(
      withLibraryDatabase(
        database,
        Effect.gen(function* () {
          return yield* (yield* SqlClient.SqlClient).withTransaction(effect);
        }),
        true,
      ),
    );
  const writeRows = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    provideStorage(withDatabaseTransaction(home, effect));
  const keepFiles = Effect.fn("AuthorHistory.keepFiles")(function* (
    hash: Hash,
    tree: History.Tree,
  ) {
    const files = tree.filter((entry) => entry.kind === "file");
    const batch = yield* bytes
      .keepMany(files.map((entry) => entry.bytes))
      .pipe(Effect.catchTag("FileBytesInvalid", (error) => Effect.fail(byteFailure(hash, error))));
    const blobs = new Map<Uint8Array, Hash>();
    for (const [index, file] of files.entries()) {
      const blob = batch.hashes[index];
      if (blob === undefined) return yield* Effect.die("Author file batch lengths differ");
      blobs.set(file.bytes, blob);
    }
    return {
      register: batch.register,
      blob: (content: Uint8Array) =>
        Effect.gen(function* () {
          const blob = blobs.get(content);
          if (blob === undefined) return yield* Effect.die("Author file missing from batch");
          return blob;
        }),
    };
  });
  const prepareRevision = Effect.fn("AuthorHistory.prepareRevisionRows")(function* (text: string) {
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(text);
    const revision = yield* Schema.decodeUnknownEffect(History.Revision, {
      onExcessProperty: "error",
    })(value);
    return { revision } satisfies StoredRevision;
  });
  const ensureMetadata = Effect.fn("AuthorHistory.prepareMetadata")(function* (create = false) {
    if (prepared) return true;
    const names = yield* fs
      .readDirectory(recoveryDirectory)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    const recoveries = names
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .sort()
      .map((name) => ({ name, hash: Hash.make(`sha256:${name.slice(0, 64)}`) }));
    const exists = yield* provideStorage(
      prepareLibraryDatabase(home, create || recoveries.length > 0),
    );
    if (!exists) return false;
    if (recoveries.length > 0) {
      const known = yield* readRows(
        knownHistoryRows(
          "tree",
          recoveries.map(({ hash }) => hash),
        ),
      );
      const trees = yield* Effect.forEach(
        recoveries.filter(({ hash }) => !known.has(hash)),
        ({ name, hash }) =>
          Effect.gen(function* () {
            const text = yield* fs.readFileString(path.join(recoveryDirectory, name));
            const { entries } = yield* Schema.decodeUnknownEffect(ManifestDocument, {
              onExcessProperty: "error",
            })(text);
            const files = entries.filter((entry) => entry.kind === "file");
            const batch = yield* bytes.keepMany(
              yield* bytes.readMany(
                files.map((entry) => entry.blob),
                true,
              ),
            );
            return { hash, entries, register: batch.register };
          }),
      );
      if (trees.length > 0)
        yield* writeRows(
          Effect.gen(function* () {
            for (const tree of trees) {
              yield* tree.register;
              yield* saveTreeRows(tree.hash, { entries: tree.entries });
            }
          }),
        );
    }
    prepared = true;
    return true;
  });
  const keepTree = Effect.fn("AuthorHistory.keepTree")(function* (tree: History.Tree) {
    const hash = yield* History.treeHash(tree).pipe(Effect.provideService(Digest.Digest, digests));
    const batch = yield* keepFiles(hash, tree);
    const entries = yield* Effect.forEach(History.sortTree(tree), (entry) =>
      Effect.gen(function* () {
        if (entry.kind !== "file") return entry;
        return {
          path: entry.path,
          kind: entry.kind,
          mode: entry.mode,
          blob: yield* batch.blob(entry.bytes),
        };
      }),
    );

    const text = yield* Schema.encodeEffect(ManifestDocument)({
      schema: "skit.author-tree.v1",
      entries,
    });
    yield* writeImmutable(
      path.join(recoveryDirectory, `${hashHex(hash)}.json`),
      new TextEncoder().encode(text),
    );
    yield* flush(recoveryDirectory);
    prepared = false;
  });
  const store = yield* History.makeStore({
    read: (kind, hash) =>
      Effect.gen(function* () {
        if (!(yield* ensureMetadata())) return Option.none<string>();
        if (kind === "revision") {
          const value = yield* readRows(loadRevisionRows(hash));
          if (!value) return Option.none<string>();
          return Option.some(
            JSON.stringify({
              ...value.revision,
              author: value.revision.author,
            }),
          );
        }
        const value = yield* readRows(loadTreeRows(hash));
        if (!value) return Option.none<string>();
        const files = value.entries.filter((entry) => entry.kind === "file");
        const contents = yield* readBlobs(
          hash,
          files.map((entry) => entry.blob),
        );
        const loaded = new Map<Hash, Uint8Array>();
        for (const [index, entry] of files.entries()) {
          const content = contents[index];
          if (content === undefined) return yield* Effect.die("Author file batch lengths differ");
          loaded.set(entry.blob, content);
        }
        const tree = yield* Effect.forEach(value.entries, (entry) =>
          Effect.gen(function* () {
            if (entry.kind === "file") {
              const content = loaded.get(entry.blob);
              if (content === undefined) return yield* Effect.die("Author file missing from batch");
              return {
                path: entry.path,
                kind: entry.kind,
                mode: entry.mode,
                bytes: content,
              };
            }
            return entry.kind === "directory"
              ? { path: entry.path, kind: entry.kind }
              : { path: entry.path, kind: entry.kind, target: entry.target };
          }),
        );
        return Option.some(yield* Schema.encodeEffect(TreeDocument)(tree));
      }).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(
            new History.StoreCorrupt({
              kind,
              hash,
              reason: { _tag: "InvalidData", failure: error },
            }),
          ),
        ),
        Effect.mapError(storageError),
      ),
    write: (kind, hash, text) =>
      Effect.gen(function* () {
        // Readback must see existing corruption; a repeated save never repairs an immutable value.
        if ((yield* ensureMetadata()) && (yield* readRows(hasHistoryRows(kind, hash)))) return;
        if (kind === "tree") {
          const tree = yield* Schema.decodeUnknownEffect(TreeDocument, {
            onExcessProperty: "error",
          })(text);
          const batch = yield* keepFiles(hash, tree);
          const entries: StoredEntry[] = yield* Effect.forEach(tree, (entry) =>
            Effect.gen(function* () {
              if (entry.kind === "file")
                return {
                  kind: entry.kind,
                  path: entry.path,
                  mode: entry.mode,
                  blob: yield* batch.blob(entry.bytes),
                };
              return entry.kind === "directory"
                ? { kind: entry.kind, path: entry.path }
                : { kind: entry.kind, path: entry.path, target: entry.target };
            }),
          );

          yield* ensureMetadata(true);
          yield* writeRows(
            Effect.gen(function* () {
              yield* batch.register;
              yield* saveTreeRows(hash, { entries });
            }),
          );
        } else {
          const revision = yield* prepareRevision(text);
          yield* ensureMetadata(true);
          yield* writeRows(saveRevisionRows(hash, revision));
        }
      }).pipe(Effect.mapError(storageError)),
    has: (kind, hash) =>
      Effect.gen(function* () {
        return (yield* ensureMetadata()) ? yield* readRows(hasHistoryRows(kind, hash)) : false;
      }).pipe(Effect.mapError(failed)),
    list: (kind) =>
      Effect.gen(function* () {
        return (yield* ensureMetadata()) ? yield* readRows(listHistoryRows(kind)) : [];
      }).pipe(Effect.mapError(failed)),
  });
  // Validate before the shared content-addressed encoder can discard an excess property.
  // This is the client store boundary; the shared History/wire contract stays unchanged.
  const checkTree = (tree: History.Tree) =>
    Schema.decodeUnknownEffect(History.Tree, { onExcessProperty: "error" })(tree).pipe(
      Effect.mapError(failed),
    );
  const checked: History.Store = {
    ...store,
    putTree: (tree) => checkTree(tree).pipe(Effect.flatMap(store.putTree)),
    commit: (revision) =>
      Schema.decodeUnknownEffect(History.Revision, { onExcessProperty: "error" })(revision).pipe(
        Effect.mapError(failed),
        Effect.flatMap(store.commit),
      ),
  };
  return {
    store: checked,
    keepTree: (tree: History.Tree) =>
      checkTree(tree).pipe(Effect.flatMap(keepTree), Effect.mapError(storageError)),
  };
});
