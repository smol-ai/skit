/** AuthorHistory owns relational metadata, immutable file bytes and native recovery evidence.
 * Only its loader reads earlier loose tree/revision documents. */
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { JsonObject, canonicalJson } from "../shared/json.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
  withDatabaseTransaction,
} from "../library/store/database.js";
import { prepareHistoryJournal } from "./history-journal.js";
import {
  hasHistoryRows,
  knownHistoryRows,
  listHistoryRows,
  loadTreeRows,
  loadRevisionRows,
  saveTreeRows,
  saveRevisionRows,
  loadLegacyHistoryDocument,
  saveLegacyHistoryDocument,
  type StoredTree,
  type StoredEntry,
  type StoredRevision,
} from "./history-rows.js";
import { Digest } from "effect/crypto";
import { Hash, hashHex, sha256Hash } from "../shared/hash.js";
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

const storedFolder = (path: Path.Path, directory: string, kind: History.Kind) =>
  path.join(directory, kind === "tree" ? "trees" : "revisions");

/** Flush bytes before their metadata transaction; History.Store verifies canonical identities. */
export const makeHistoryStore = Effect.fn("AuthorHistory.makeStore")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digests = yield* Digest.Digest;
  const home = path.dirname(directory);
  const database = libraryDatabasePath(home);
  const legacyBlobDirectory = path.join(directory, "blobs");
  const bytes = yield* makeFileBytes(home);
  const recoveryDirectory = path.join(directory, "recovery", "trees");
  let prepared = false;
  const legacyBlobPath = (hash: Hash) => path.join(legacyBlobDirectory, hashHex(hash));
  const hashBytes = (bytes: Uint8Array) =>
    sha256Hash(bytes).pipe(Effect.provideService(Digest.Digest, digests));
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
      .loadLegacyMany(blobs.map((hash) => ({ path: legacyBlobPath(hash), hash })))
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
  const extra = (value: JsonObject, known: readonly string[]) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)));
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
  const prepareTree = Effect.fn("AuthorHistory.prepareTreeRows")(function* (
    hash: Hash,
    text: string,
  ) {
    const value = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Union([Schema.Array(JsonObject), JsonObject])),
    )(text);
    let entries: readonly StoredEntry[];
    let metadata: JsonObject = {};
    let register: Effect.Effect<
      void,
      FileBytesInvalid | SqlError | Schema.SchemaError,
      SqlClient.SqlClient
    > = Effect.void;
    if (Array.isArray(value)) {
      const tree = yield* Schema.decodeUnknownEffect(TreeDocument)(text);
      const batch = yield* keepFiles(hash, tree);
      register = batch.register;
      entries = yield* Effect.forEach(tree, (entry, index) =>
        Effect.gen(function* () {
          const raw = value[index];
          if (raw === undefined) return yield* Effect.die("Author tree lengths differ");
          if (entry.kind === "file")
            return {
              kind: entry.kind,
              path: entry.path,
              mode: entry.mode,
              blob: yield* batch.blob(entry.bytes),
              extra: extra(raw, ["kind", "path", "mode", "bytes"]),
            };
          return entry.kind === "directory"
            ? { kind: entry.kind, path: entry.path, extra: extra(raw, ["kind", "path"]) }
            : {
                kind: entry.kind,
                path: entry.path,
                target: entry.target,
                extra: extra(raw, ["kind", "path", "target"]),
              };
        }),
      );
    } else {
      const manifest = yield* Schema.decodeUnknownEffect(JsonObject)(value);
      yield* Schema.decodeUnknownEffect(TreeManifest)(manifest);
      const rawEntries = yield* Schema.decodeUnknownEffect(Schema.Array(JsonObject))(
        manifest.entries,
      );
      entries = yield* Effect.forEach(rawEntries, (raw) =>
        Effect.gen(function* () {
          const entry = yield* Schema.decodeUnknownEffect(
            Schema.Union([TreeDirectory, StoredFile, TreeSymlink]),
          )(raw);
          if (entry.kind === "file")
            return {
              kind: entry.kind,
              path: entry.path,
              mode: entry.mode,
              blob: entry.blob,
              extra: extra(raw, ["kind", "path", "mode", "blob"]),
            };
          return entry.kind === "directory"
            ? { kind: entry.kind, path: entry.path, extra: extra(raw, ["kind", "path"]) }
            : {
                kind: entry.kind,
                path: entry.path,
                target: entry.target,
                extra: extra(raw, ["kind", "path", "target"]),
              };
        }),
      );
      const files = entries.filter((entry) => entry.kind === "file");
      const batch = yield* bytes.keepMany(
        yield* readBlobs(
          hash,
          files.map((entry) => entry.blob),
        ),
      );
      register = batch.register;
      metadata = extra(manifest, ["schema", "entries"]);
    }
    return { tree: { entries, extra: metadata } satisfies StoredTree, register };
  });
  const prepareRevision = Effect.fn("AuthorHistory.prepareRevisionRows")(function* (text: string) {
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(text);
    const revision = yield* Schema.decodeUnknownEffect(History.Revision)(value);
    const author = yield* Schema.decodeUnknownEffect(JsonObject)(value.author);
    return {
      revision,
      extra: extra(value, ["tree", "parents", "author", "edits"]),
      authorExtra: extra(author, ["device", "at"]),
    } satisfies StoredRevision;
  });
  const sourceFiles = Effect.fn("AuthorHistory.sourceFiles")(function* (
    folder: string,
    kind: History.Kind,
  ) {
    const names = yield* fs
      .readDirectory(folder)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    return names
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .sort()
      .map((name) => ({
        kind,
        hash: Hash.make(`sha256:${name.slice(0, 64)}`),
        file: path.join(folder, name),
      }));
  });
  const ensureMetadata = Effect.fn("AuthorHistory.prepareMetadata")(function* (create = false) {
    if (prepared) return true;
    const recoveries = yield* sourceFiles(recoveryDirectory, "tree");
    const exists = yield* provideStorage(prepareLibraryDatabase(home));
    const imported = exists
      ? yield* readRows(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return (yield* sql`SELECT id FROM author_metadata_import WHERE id=1`).length > 0;
          }),
        )
      : false;
    if (imported && recoveries.length === 0) {
      prepared = true;
      return true;
    }
    const files = imported
      ? []
      : [
          ...(yield* sourceFiles(storedFolder(path, directory, "tree"), "tree")),
          ...(yield* sourceFiles(storedFolder(path, directory, "revision"), "revision")),
        ];
    if (!create && !imported && files.length === 0 && recoveries.length === 0) return false;
    if (!exists) yield* provideStorage(prepareLibraryDatabase(home, true));
    const sources = imported ? recoveries : [...files, ...recoveries];
    const known = yield* readRows(
      Effect.gen(function* () {
        return {
          tree: yield* knownHistoryRows(
            "tree",
            sources.filter((source) => source.kind === "tree").map((source) => source.hash),
          ),
          revision: yield* knownHistoryRows(
            "revision",
            sources.filter((source) => source.kind === "revision").map((source) => source.hash),
          ),
        };
      }),
    );
    const documents = yield* Effect.forEach(sources, (source) =>
      Effect.gen(function* () {
        if (known[source.kind].has(source.hash)) return undefined;
        const text = yield* fs.readFileString(source.file);
        // Invalid legacy metadata remains exact, readable evidence. It is validated on access.
        if (source.kind === "tree") {
          const tree = yield* Effect.result(prepareTree(source.hash, text));
          return { ...source, text, ...(tree._tag === "Success" ? { tree: tree.success } : {}) };
        }
        const revision = yield* Effect.result(prepareRevision(text));
        return {
          ...source,
          text,
          ...(revision._tag === "Success" ? { revision: revision.success } : {}),
        };
      }),
    );
    if (imported && documents.every((document) => document === undefined)) {
      prepared = true;
      return true;
    }
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* provideStorage(prepareHistoryJournal(home));
    const sourceHash = yield* hashBytes(
      new TextEncoder().encode(
        canonicalJson(
          documents
            .filter((value) => value !== undefined)
            .map((value) => ({ kind: value.kind, hash: value.hash, text: value.text })),
        ),
      ),
    );
    yield* writeRows(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Another owner may have completed the import while this one decoded immutable sources.
        const exists = (yield* sql`SELECT id FROM author_metadata_import WHERE id=1`).length > 0;
        for (const document of documents.toSorted(
          (left, right) => (left?.kind === "tree" ? 0 : 1) - (right?.kind === "tree" ? 0 : 1),
        )) {
          if (!document) continue;
          if (exists && !recoveries.some((source) => source.file === document.file)) continue;
          if ("tree" in document && document.tree) {
            yield* document.tree.register;
            yield* saveTreeRows(document.hash, document.tree.tree);
          } else if ("revision" in document && document.revision)
            yield* saveRevisionRows(document.hash, document.revision, document.text);
          else yield* saveLegacyHistoryDocument(document.kind, document.hash, document.text);
        }
        if (!exists)
          yield* sql`INSERT INTO author_metadata_import(id,source_hash) VALUES(1,${sourceHash})`;
      }),
    );
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
          if (!value)
            return Option.fromUndefinedOr(yield* readRows(loadLegacyHistoryDocument(kind, hash)));
          return Option.some(
            JSON.stringify({
              ...value.extra,
              ...value.revision,
              author: { ...value.authorExtra, ...value.revision.author },
            }),
          );
        }
        const value = yield* readRows(loadTreeRows(hash));
        if (!value)
          return Option.fromUndefinedOr(yield* readRows(loadLegacyHistoryDocument(kind, hash)));
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
                ...entry.extra,
                path: entry.path,
                kind: entry.kind,
                mode: entry.mode,
                bytes: content,
              };
            }
            return entry.kind === "directory"
              ? { ...entry.extra, path: entry.path, kind: entry.kind }
              : { ...entry.extra, path: entry.path, kind: entry.kind, target: entry.target };
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
          const tree = yield* Schema.decodeUnknownEffect(TreeDocument)(text);
          const batch = yield* keepFiles(hash, tree);
          const entries: StoredEntry[] = yield* Effect.forEach(tree, (entry) =>
            Effect.gen(function* () {
              if (entry.kind === "file")
                return {
                  kind: entry.kind,
                  path: entry.path,
                  mode: entry.mode,
                  blob: yield* batch.blob(entry.bytes),
                  extra: {},
                };
              return entry.kind === "directory"
                ? { kind: entry.kind, path: entry.path, extra: {} }
                : { kind: entry.kind, path: entry.path, target: entry.target, extra: {} };
            }),
          );

          yield* ensureMetadata(true);
          yield* writeRows(
            Effect.gen(function* () {
              yield* batch.register;
              yield* saveTreeRows(hash, { entries, extra: {} });
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
  return {
    store,
    keepTree: (tree: History.Tree) => keepTree(tree).pipe(Effect.mapError(storageError)),
  };
});
