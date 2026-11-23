import { loadOperations, loadLibrary } from "../src/library/store/library-store.js";
import { describe, assert, it } from "@effect/vitest";

import { Effect, FileSystem, Layer, Option } from "effect";
import { basename, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { walkTree } from "../src/artifact/tree.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import * as Library from "../src/library/library.js";
import { readPathEvidence } from "../src/library/folder-evidence.js";

import { libraryDatabasePath } from "../src/library/store/database.js";

import { localImportRequest } from "../src/library/setup/local-import.js";
import { inspectRecoveryOperation } from "../src/library/internal/recovery/moves.js";
import { canonicalJson } from "../src/shared/json.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

const fixture = Effect.fn("test.undoRecovery.fixture")(function* (
  reconstruct = false,
  composition = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-undo-recorded-" }),
  );
  const home = join(root, "library");
  const paths = [join(root, "first"), join(root, "second")];
  for (const path of paths) {
    yield* fs.makeDirectory(path);
    yield* fs.writeFileString(join(path, "SKILL.md"), basename(path));
  }
  if (composition) yield* fs.chmod(paths[0]!, 0o700);
  const layer = Library.layer({ home, roots: testRoots(home) });
  const plan = yield* Effect.gen(function* () {
    const owner = yield* Library.Service;
    if (reconstruct) {
      const request = yield* localImportRequest(paths[0]!, "2026-11-05T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Missing reconstruction source");
      yield* owner.import.collection(request.value);
    }
    const folders = yield* Effect.forEach(paths, (path) =>
      Effect.gen(function* () {
        const evidence = yield* readPathEvidence(path);
        if (Option.isNone(evidence)) return yield* Effect.die("Missing fixture folder");
        return evidence.value;
      }),
    );
    const removed = yield* owner.setup([{ _tag: "Remove", folders }], { base: yield* owner.read });
    assert.strictEqual(removed._tag, "Done");
    if (reconstruct) {
      const saved = yield* inspectRecoveryOperation(home, removed.operationId);
      yield* fs.remove(saved.entries[0]!.recoveryPath, { recursive: true });
    }
    if (composition) {
      const snapshot = yield* owner.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Missing Library");
      const hash = snapshot.state.collection_versions[0]!.hash;
      const originals = join(home, "originals");
      const retained = collectionVersionPath(originals, hash);
      const entries = [];
      for (const entry of yield* walkTree(retained, "verbatim")) {
        if (entry.kind === "symlink") return yield* Effect.die("Unexpected test symlink");
        if (entry.kind === "directory") entries.push(entry);
        else {
          const blob = `sha256:${createHash("sha256").update(entry.bytes).digest("hex")}`;
          const path = join(originals, "compositions/blobs", blob.slice(7));
          yield* fs.makeDirectory(dirname(path), { recursive: true });
          yield* fs.writeFile(path, entry.bytes);
          entries.push({ path: entry.path, kind: "file", mode: entry.mode, blob });
        }
      }
      const path = join(originals, "compositions/trees", `${hash.slice(7)}.json`);
      yield* fs.makeDirectory(dirname(path), { recursive: true });
      yield* fs.writeFileString(
        path,
        JSON.stringify({ schema: "skit.library-composition.v1", entries }),
      );
      yield* fs.remove(retained, { recursive: true });
    }
    return yield* owner.plan(
      { _tag: "Undo", operationId: removed.operationId },
      { base: yield* owner.read },
    );
  }).pipe(Effect.provide(layer));
  const statePath = libraryDatabasePath(home);
  const read = loadLibrary(home);
  const operations = loadOperations(home);
  return { fs, home, paths, plan, layer, read, operations, statePath };
});

describe("skit library undo", () => {
  describe("An interrupted Undo can continue without overwriting new edits.", () => {
    for (const boundary of ["record", "rename", "copy", "completion"] as const)
      for (const composition of boundary === "copy" ? [false, true] : [false])
        for (const diverge of boundary === "rename" || boundary === "copy"
          ? [false, true]
          : [false])
          it.effect(
            `Undo ${diverge ? "stops on divergence" : "resumes"} after ${boundary}${composition ? " from a composition" : ""}`,
            () =>
              Effect.gen(function* () {
                const f = yield* fixture(boundary === "copy", composition);
                let interrupted = false;
                const faultFs: FileSystem.FileSystem = {
                  ...f.fs,
                  chmod: (path, mode) =>
                    Effect.gen(function* () {
                      if (
                        !interrupted &&
                        path === f.statePath &&
                        (boundary === "record" || boundary === "completion")
                      ) {
                        const last = (yield* f.operations.pipe(
                          Effect.provideService(FileSystem.FileSystem, f.fs),
                          Effect.orDie,
                        )).at(-1);
                        if (
                          last?._tag === "Pending" &&
                          last.steps[0]?.step._tag === "Undo" &&
                          (boundary === "record" || last.steps[0].status === "Done")
                        ) {
                          interrupted = true;
                          return yield* Effect.die("Process exited at Undo SQL checkpoint");
                        }
                      }
                      yield* f.fs.chmod(path, mode);
                    }),
                  rename: (from, to) =>
                    Effect.gen(function* () {
                      yield* f.fs.rename(from, to);
                      if (interrupted) return;
                      if ((boundary === "rename" || boundary === "copy") && to === f.paths[0]) {
                        interrupted = true;
                        return yield* Effect.die("Process exited after first restore rename");
                      }
                    }),
                };
                const exit = yield* Effect.exit(
                  Effect.flatMap(Library.Service, (owner) =>
                    owner.apply({ _tag: "Apply", plan: f.plan }),
                  ).pipe(
                    Effect.provide(
                      f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, faultFs))),
                    ),
                  ),
                );
                assert.strictEqual(exit._tag, "Failure");
                assert.isTrue(interrupted);
                const pending = (yield* f.operations.pipe(
                  Effect.provideService(FileSystem.FileSystem, f.fs),
                  Effect.orDie,
                )).at(-1);
                assert.strictEqual(pending?._tag, "Pending");
                if (!pending) return assert.fail("Missing recorded Undo");
                if (diverge && boundary === "copy") {
                  // Identical bytes at a new inode are not the entry Undo recorded before its rename.
                  const owned = join(f.home, "first-restored-copy");
                  yield* f.fs.rename(f.paths[0]!, owned);
                  yield* f.fs.copy(owned, f.paths[0]!);
                } else if (diverge) {
                  yield* f.fs.makeDirectory(f.paths[1]!);
                  yield* f.fs.writeFileString(join(f.paths[1]!, "SKILL.md"), "user edit");
                }
                yield* Effect.gen(function* () {
                  const owner = yield* Library.Service;
                  assert.deepStrictEqual(
                    owner.startup.finished,
                    diverge ? [] : [pending.operationId],
                    canonicalJson(owner.startup.stopped),
                  );
                  assert.strictEqual(owner.startup.stopped.length, diverge ? 1 : 0);
                  for (const path of f.paths) {
                    if (diverge && boundary === "copy" && path === f.paths[1]) {
                      assert.isFalse(yield* f.fs.exists(path));
                      continue;
                    }
                    assert.strictEqual(
                      yield* f.fs.readFileString(join(path, "SKILL.md")),
                      diverge && path === f.paths[1] ? "user edit" : basename(path),
                    );
                  }
                  if (!diverge) {
                    yield* f.fs.writeFileString(join(f.paths[0]!, "SKILL.md"), "later edit");
                    const before = yield* f.read;
                    const again = yield* owner.plan(f.plan.intent, { base: yield* owner.read });
                    assert.strictEqual(
                      (yield* owner.apply({ _tag: "Apply", plan: again })).result._tag,
                      "AlreadyUndone",
                    );
                    assert.deepStrictEqual(yield* f.read, before);
                    assert.strictEqual(
                      yield* f.fs.readFileString(join(f.paths[0]!, "SKILL.md")),
                      "later edit",
                    );
                  }
                }).pipe(Effect.provide(f.layer));
              }).pipe(Effect.provide(skitLayer), Effect.scoped),
          );
  });
});

describe("skit library undo", () => {
  describe("Undo preview changes no files.", () => {
    it.effect("Undo preview leaves files and saved state unchanged", () =>
      Effect.gen(function* () {
        const f = yield* fixture();

        const before = yield* f.read;
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;

          yield* owner.plan(f.plan.intent, { base: yield* owner.read });

          assert.deepStrictEqual(yield* f.read, before);
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
  });
});

describe("skit library undo", () => {
  describe("Undo refuses changed files or changed approval.", () => {
    it.effect("Undo refuses a destination changed since review", () =>
      Effect.gen(function* () {
        const f = yield* fixture();

        const before = yield* f.read;
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;

          yield* f.fs.makeDirectory(f.paths[1]!);

          yield* f.fs.writeFileString(join(f.paths[1]!, "SKILL.md"), "user edit");

          const failure = yield* Effect.flip(owner.apply({ _tag: "Apply", plan: f.plan }));

          assert.strictEqual(failure._tag, "Library.StalePlan");

          assert.deepStrictEqual(yield* f.read, before);

          assert.isFalse(yield* f.fs.exists(f.paths[0]!));
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
  });
});
