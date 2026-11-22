import { fileBytesAvailable } from "./file-bytes-table.js";
import { Effect, FileSystem, Schema } from "effect";
import { Digest } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { dirname, join, resolve } from "node:path";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { Hash, hashHex, sha256Hash } from "../shared/hash.js";
import { syncPaths } from "../platform/atomic-write.js";
import {
  libraryDatabasePath,
  withDatabaseTransaction,
  withLibraryDatabase,
} from "../library/store/database.js";

export class FileBytesInvalid
  extends Schema.TaggedError<FileBytesInvalid, { readonly brand: unique symbol }>()(
    "FileBytesInvalid",
    {
      path: Schema.String,
      hash: Hash,
      reason: Schema.TaggedUnion({
        Missing: {},
        HashMismatch: { actual: Hash },
        NotFile: {},
        SizeMismatch: { expected: Schema.Int, actual: Schema.Int },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export const fileBytesPath = (home: string, hash: Hash) =>
  join(resolve(home), "file-bytes", hashHex(hash));

/** Canonical bytes have no executable mode or native recovery identity; callers own those views. */
export const makeFileBytes = Effect.fn("FileBytes.make")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  const root = resolve(home),
    directory = join(root, "file-bytes"),
    database = libraryDatabasePath(root);
  const provide = <A, E>(program: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    program.pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const hashBytes = (bytes: Uint8Array) =>
    sha256Hash(bytes).pipe(Effect.provideService(Digest.Digest, digest));
  const invalid = (path: string, hash: Hash, reason: typeof FileBytesInvalid.fields.reason.Type) =>
    new FileBytesInvalid({ path, hash, reason });
  const FileFact = Schema.Struct({
    hash: Hash,
    size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  });
  const knownMany = Effect.fn("FileBytes.knownMany")(function* (hashes: readonly Hash[]) {
    yield* Schema.decodeUnknownEffect(Schema.Array(Hash))(hashes);
    if (hashes.length === 0 || !(yield* fs.exists(database))) return new Map<Hash, number>();
    return yield* provide(
      withLibraryDatabase(
        database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (!(yield* fileBytesAvailable)) return new Map<Hash, number>();
          const facts = new Map<Hash, number>();
          const unique = [...new Set(hashes)];
          for (let start = 0; start < unique.length; start += 500) {
            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(FileFact))(
              yield* sql`SELECT hash,size FROM file_bytes WHERE hash IN ${sql.in(unique.slice(start, start + 500))}`,
            );
            for (const row of rows) facts.set(row.hash, row.size);
          }
          return facts;
        }),
        true,
      ),
    );
  });
  const readFile = Effect.fn("FileBytes.readFile")(function* (
    path: string,
    hash: Hash,
    size?: number,
  ) {
    const info = yield* fs
      .lstat(path)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(invalid(path, hash, { _tag: "Missing" })),
        ),
      );
    if (info.type !== "File") return yield* invalid(path, hash, { _tag: "NotFile" });
    const bytes = yield* fs
      .readFile(path)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(invalid(path, hash, { _tag: "Missing" })),
        ),
      );
    const actual = yield* hashBytes(bytes);
    if (actual !== hash) return yield* invalid(path, hash, { _tag: "HashMismatch", actual });
    if (size !== undefined && bytes.byteLength !== size)
      return yield* invalid(path, hash, {
        _tag: "SizeMismatch",
        expected: size,
        actual: bytes.byteLength,
      });
    return bytes;
  });
  const keep = Effect.fn("FileBytes.keep")(function* (
    hash: Hash,
    bytes: Uint8Array,
    size?: number,
  ) {
    const target = fileBytesPath(root, hash);
    if (size !== undefined) {
      yield* readFile(target, hash, size);
      return true;
    }
    if (yield* fs.exists(target)) {
      yield* readFile(target, hash);
    } else {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".pending-" });
          const temporary = join(staging, "bytes");
          const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(bytes);
          yield* file.sync;
          yield* readFile(temporary, hash);
          yield* fs.link(temporary, target).pipe(
            Effect.uninterruptible,
            Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
          );
        }),
      );
      yield* readFile(target, hash);
    }
    return false;
  });
  // A batch owns its verified immutable facts. Only its registration Effect may publish them.
  // All filesystem work finishes before the caller opens the metadata transaction.
  const stage = Effect.fn("FileBytes.stage")(function* (
    files: readonly { readonly hash: Hash; readonly content: Uint8Array }[],
  ) {
    const known = yield* knownMany(files.map(({ hash }) => hash));
    // Staging can create the home before its database exists. Only a new home adds an entry to its parent.
    const newHome = files.length > 0 && !(yield* fs.exists(root));
    const facts = new Map<Hash, number>();
    const verified = new Set<Hash>();
    for (const { hash, content } of files) {
      if (verified.has(hash)) continue;
      if (!(yield* keep(hash, content, known.get(hash)))) facts.set(hash, content.byteLength);
      verified.add(hash);
    }
    if (facts.size > 0)
      yield* syncPaths([
        ...Array.from(facts.keys(), (hash) => fileBytesPath(root, hash)),
        directory,
        root,
        ...(newHome ? [dirname(root)] : []),
      ]).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    return facts;
  });
  const register = (facts: ReadonlyMap<Hash, number>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const entries = [...facts].map(([hash, size]) => ({ hash, size }));
      for (let start = 0; start < entries.length; start += 500) {
        const chunk = entries.slice(start, start + 500);
        const [first, ...rest] = chunk;
        if (first)
          yield* sql`INSERT INTO file_bytes ${sql.insert([first, ...rest])} ON CONFLICT(hash) DO NOTHING`;
        const rows = yield* Schema.decodeUnknownEffect(Schema.Array(FileFact))(
          yield* sql`SELECT hash,size FROM file_bytes WHERE hash IN ${sql.in(chunk.map((entry) => entry.hash))}`,
        );
        for (const row of rows) {
          const size = facts.get(row.hash);
          if (row.size !== size && size !== undefined)
            return yield* invalid(fileBytesPath(root, row.hash), row.hash, {
              _tag: "SizeMismatch",
              expected: row.size,
              actual: size,
            });
        }
      }
    });
  return {
    keepMany: Effect.fn("FileBytes.keepMany")(function* <A>(
      entries: readonly A[],
      bytesOf: (entry: A) => Uint8Array,
    ) {
      const copies = entries.map((entry) => ({ entry, content: Uint8Array.from(bytesOf(entry)) }));
      const files = yield* Effect.forEach(copies, ({ entry, content }) =>
        Effect.map(hashBytes(content), (hash) => ({ entry, hash, content })),
      );
      const facts = yield* stage(files);
      return {
        files: files.map(({ entry, hash }) => ({ entry, hash })),
        register: register(facts),
      };
    }),
    readMany: Effect.fn("FileBytes.readMany")(function* <A>(
      entries: readonly A[],
      hashOf: (entry: A) => Hash,
      allowStaged = false,
    ) {
      const files = entries.map((entry) => ({ entry, hash: hashOf(entry) }));
      const known = yield* knownMany(files.map(({ hash }) => hash));
      return yield* Effect.forEach(files, ({ entry, hash }) => {
        const path = fileBytesPath(root, hash);
        const size = known.get(hash);
        return size === undefined && !allowStaged
          ? Effect.fail(invalid(path, hash, { _tag: "Missing" }))
          : Effect.map(readFile(path, hash, size), (bytes) => ({ entry, bytes }));
      });
    }),
    read: (hash: Hash) =>
      Effect.gen(function* () {
        const size = (yield* knownMany([hash])).get(hash);
        if (size === undefined)
          return yield* invalid(fileBytesPath(root, hash), hash, { _tag: "Missing" });
        return yield* readFile(fileBytesPath(root, hash), hash, size);
      }),
    save: (content: Uint8Array) =>
      Effect.gen(function* () {
        const copy = Uint8Array.from(content);
        const hash = yield* hashBytes(copy);
        const facts = yield* stage([{ hash, content: copy }]);
        yield* provide(withDatabaseTransaction(root, register(facts)));
        return hash;
      }),
    // Recovery stages complete bytes without needing the shared writer. No metadata is acknowledged.
    keep: (content: Uint8Array) =>
      Effect.gen(function* () {
        const copy = Uint8Array.from(content);
        const hash = yield* hashBytes(copy);
        yield* stage([{ hash, content: copy }]);
        return hash;
      }),
    // Compatibility reads never change legacy or recovery evidence.
    loadLegacy: (path: string, hash: Hash) =>
      Effect.gen(function* () {
        const canonical = fileBytesPath(root, hash);
        const size = (yield* knownMany([hash])).get(hash);
        if (size !== undefined) return yield* readFile(canonical, hash, size);
        return yield* readFile(canonical, hash).pipe(
          Effect.catchTag("FileBytesInvalid", (error) =>
            error.reason._tag === "Missing" ? readFile(path, hash) : Effect.fail(error),
          ),
        );
      }),
  };
});
