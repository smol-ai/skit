import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Deferred, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { skitLayer } from "../src/platform/layer.js";
import { lockFile } from "../src/platform/file-lock.js";
import { systemError } from "effect/PlatformError";
import { isSkitFailure } from "../src/shared/failure.js";
import { makeFileBytes, fileBytesPath } from "../src/artifact/file-bytes.js";
import {
  prepareLibraryDatabase,
  libraryDatabasePath,
  withLibraryDatabase,
  withDatabaseTransaction,
} from "../src/library/store/database.js";
import { sha256Hash } from "../src/shared/hash.js";

const content = new Uint8Array([0, 128, 255, 13, 10]);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-file-bytes-" });
  return {
    home,
    fs,
    path: libraryDatabasePath(home),
    owner: yield* makeFileBytes(home),
    hash: yield* sha256Hash(content),
  };
});

it.effect(
  "reading a legacy blob neither copies it nor registers it while the home writer is held",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* prepareLibraryDatabase(f.home, true);
      const legacy = join(f.home, "legacy-blob");
      yield* f.fs.writeFile(legacy, content);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(f.home, "lock.sqlite"));
          assert.deepStrictEqual(yield* f.owner.loadLegacy(legacy, f.hash), content);
        }),
      );
      assert.isFalse(yield* f.fs.exists(fileBytesPath(f.home, f.hash)));
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT hash FROM file_bytes`, []);
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "mutating the caller buffer after hashing cannot publish the wrong bytes under its hash",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>(),
        released = yield* Deferred.make<void>();
      const controlled = yield* makeFileBytes(f.home).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          open: (path, options) =>
            f.fs
              .open(path, options)
              .pipe(
                Effect.tap(() =>
                  path.endsWith("/bytes")
                    ? Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(released)),
                      )
                    : Effect.void,
                ),
              ),
        }),
      );
      const input = Uint8Array.from(content);
      const saving = yield* controlled.save(input).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      input[0] = 99;
      yield* Deferred.succeed(released, undefined);
      assert.strictEqual(yield* Fiber.join(saving), f.hash);
      assert.deepStrictEqual(yield* f.owner.read(f.hash), content);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("identical bytes have one verified private file and one native registration", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.strictEqual(yield* f.owner.save(content), f.hash);
    assert.strictEqual(yield* f.owner.save(content), f.hash);
    const read = yield* f.owner.read(f.hash);
    assert.deepStrictEqual(read, content);
    read[0] = 7;
    assert.deepStrictEqual(yield* f.owner.read(f.hash), content);
    assert.strictEqual((yield* f.fs.stat(fileBytesPath(f.home, f.hash))).mode & 0o777, 0o600);
    assert.strictEqual((yield* f.fs.stat(join(f.home, "file-bytes"))).mode & 0o777, 0o700);
    yield* withLibraryDatabase(
      f.path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT hash,size FROM file_bytes`, [
          { hash: f.hash, size: content.byteLength },
        ]);
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const damage of ["missing", "changed"] as const)
  it.effect(`registered ${damage} bytes cannot be repaired by save or legacy import`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.owner.save(content);
      const path = fileBytesPath(f.home, f.hash);
      if (damage === "missing") yield* f.fs.remove(path);
      else yield* f.fs.writeFileString(path, "changed");
      const source = join(f.home, "legacy");
      yield* f.fs.writeFile(source, content);
      for (const operation of [
        f.owner.read(f.hash).pipe(Effect.asVoid),
        f.owner.save(content).pipe(Effect.asVoid),
        f.owner.loadLegacy(source, f.hash).pipe(Effect.asVoid),
      ]) {
        const error = yield* Effect.flip(operation);
        assert.strictEqual(error._tag, "FileBytesInvalid");
        if (error._tag === "FileBytesInvalid") {
          assert.isTrue(isSkitFailure(error));
          assert.strictEqual(error.code, "VALIDATION_FAILED");
          assert.strictEqual(error.reason._tag, damage === "missing" ? "Missing" : "HashMismatch");
        }
      }
      if (damage === "missing") assert.isFalse(yield* f.fs.exists(path));
      else assert.strictEqual(yield* f.fs.readFileString(path), "changed");
      assert.deepStrictEqual(yield* f.fs.readFile(source), content);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "recovery and legacy reads need no writer; an explicit save registers the complete file",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(f.home, "lock.sqlite"));
          assert.strictEqual(yield* f.owner.keep(content), f.hash);
          assert.isFalse(yield* f.fs.exists(f.path));
          assert.strictEqual((yield* Effect.flip(f.owner.read(f.hash)))._tag, "FileBytesInvalid");
          assert.deepStrictEqual(
            yield* f.owner.loadLegacy(join(f.home, "no-legacy"), f.hash),
            content,
          );
          assert.isFalse(yield* f.fs.exists(f.path));
        }),
      );
      const cold = yield* makeFileBytes(f.home);
      assert.deepStrictEqual(yield* cold.loadLegacy(join(f.home, "no-legacy"), f.hash), content);
      assert.strictEqual((yield* Effect.flip(cold.read(f.hash)))._tag, "FileBytesInvalid");
      assert.strictEqual(yield* cold.save(content), f.hash);
      assert.deepStrictEqual(yield* cold.read(f.hash), content);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a link failure leaves neither partial content nor an acknowledged registration", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const controlled = yield* makeFileBytes(f.home).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        link: (from, to) =>
          to === fileBytesPath(f.home, f.hash)
            ? systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "link",
                pathOrDescriptor: to,
              })
            : f.fs.link(from, to),
      }),
    );
    assert.strictEqual((yield* Effect.flip(controlled.save(content)))._tag, "PlatformError");
    assert.isFalse(yield* f.fs.exists(fileBytesPath(f.home, f.hash)));
    assert.isFalse(yield* f.fs.exists(f.path));
    assert.deepStrictEqual(yield* f.fs.readDirectory(join(f.home, "file-bytes")), []);
    assert.strictEqual(yield* f.owner.save(content), f.hash);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed registration keeps only complete durable bytes and retries without replacement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* prepareLibraryDatabase(f.home, true);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_bytes BEFORE INSERT ON file_bytes BEGIN SELECT RAISE(ABORT,'refused'); END`;
        }),
      );
      assert.strictEqual((yield* Effect.flip(f.owner.save(content)))._tag, "LibrarySqlError");
      const bytesPath = fileBytesPath(f.home, f.hash);
      const retained = yield* f.fs.stat(bytesPath);
      assert.deepStrictEqual(yield* f.fs.readFile(bytesPath), content);
      assert.strictEqual((yield* Effect.flip(f.owner.read(f.hash)))._tag, "FileBytesInvalid");
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM file_bytes`, []);
          yield* sql`DROP TRIGGER refuse_bytes`;
        }),
      );
      const cold = yield* makeFileBytes(f.home);
      assert.deepStrictEqual(yield* cold.loadLegacy(join(f.home, "no-legacy"), f.hash), content);
      assert.strictEqual(yield* cold.save(content), f.hash);
      assert.deepStrictEqual((yield* f.fs.stat(bytesPath)).ino, retained.ino);
      assert.deepStrictEqual(yield* cold.read(f.hash), content);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "independent owners deduplicate concurrent writers and refuse mismatched legacy source bytes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owners = yield* Effect.forEach([0, 1, 2], () => makeFileBytes(f.home));
      const hashes = yield* Effect.forEach(owners, (owner) => owner.save(content), {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(hashes, [f.hash, f.hash, f.hash]);
      assert.deepStrictEqual(yield* f.fs.readDirectory(join(f.home, "file-bytes")), [
        f.hash.slice(7),
      ]);
      const source = join(f.home, "wrong");
      yield* f.fs.writeFileString(source, "wrong bytes");
      const absent = yield* sha256Hash(new Uint8Array([11]));
      const error = yield* Effect.flip(f.owner.loadLegacy(source, absent));
      assert.strictEqual(error._tag, "FileBytesInvalid");
      assert.strictEqual((yield* Effect.flip(f.owner.read(absent)))._tag, "FileBytesInvalid");
      assert.isFalse(yield* f.fs.exists(fileBytesPath(f.home, absent)));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a durable byte batch flushes parents once and registers atomically with owner metadata",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* prepareLibraryDatabase(f.home, true);
      const contents = Array.from({ length: 12 }, (_, index) => new Uint8Array([index, 255]));
      const parentFlushes = new Map<string, number>();
      const controlled = yield* makeFileBytes(f.home).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          open: (path, options) =>
            f.fs.open(path, options).pipe(
              Effect.tap(() => {
                if (options?.flag === "r")
                  parentFlushes.set(path, (parentFlushes.get(path) ?? 0) + 1);
                return Effect.void;
              }),
            ),
        }),
      );
      const batch = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(f.home, "lock.sqlite"));
          return yield* controlled.keepMany(contents, (content) => content);
        }),
      );
      assert.strictEqual(parentFlushes.get(join(f.home, "file-bytes")), 1);
      assert.strictEqual(parentFlushes.get(f.home), 1);
      assert.deepStrictEqual(
        batch.files.map(({ entry }) => entry),
        contents,
      );
      for (const { entry, hash } of batch.files)
        assert.deepStrictEqual(yield* f.fs.readFile(fileBytesPath(f.home, hash)), entry);
      const refused = yield* Effect.flip(
        withDatabaseTransaction(
          f.home,
          Effect.gen(function* () {
            yield* batch.register;
            return yield* Effect.fail("owner metadata refused");
          }),
        ),
      );
      assert.strictEqual(refused, "owner metadata refused");
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM file_bytes`, []);
        }),
        true,
      );
      yield* withDatabaseTransaction(f.home, batch.register);
      assert.deepStrictEqual(
        batch.files.map(({ entry }) => entry),
        contents,
      );
      for (const { entry, hash } of batch.files)
        assert.deepStrictEqual(yield* f.owner.read(hash), entry);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
