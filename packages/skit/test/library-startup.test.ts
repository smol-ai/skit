import { loadOperations } from "../src/library/store/library-store.js";
import { describe, assert, it } from "@effect/vitest";

import { Context, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPathEvidence } from "../src/library/folder-evidence.js";
import * as Library from "../src/library/library.js";

import {
  inspectLocalLibraryState,
  migrateLocalLibraryState,
} from "../src/library/store/state-file.js";
import { lockFile } from "../src/platform/file-lock.js";
import { skitLayer } from "../src/platform/layer.js";
import { libraryLayer } from "./helpers/library-store.js";

// Package-local evidence reader for the crash fixture; the child uses public owner APIs.
// `pnpm build` runs before the tests.
const folderEvidence = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "library", "folder-evidence.js"),
).href;

/**
 * A SKIT process that removes `folder` through Library.setup and stops just before its
 * recorded operation boundary, saying so, to be killed there: earlier writes are on disk.
 */
const setupProcess = (home: string, folder: string, boundary: string) =>
  ChildProcess.make(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { Context, Effect, FileSystem, Layer, Option } from "effect";
       import * as Library from "@smolai/skit-core/library";
       import { skitLayer } from "@smolai/skit-core/platform";
       const [url, home, folder, boundary] = process.argv.slice(1);
       const { readPathEvidence } = await import(url);
       const { inspectLocalLibraryState, loadOperations } = await import(new URL("./store/library-store.js", url));
       const paused = Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, (fs) => {
         const gate = Effect.andThen(Effect.sync(() => process.stdout.write("paused\\n")), Effect.never);
         return { ...fs,
           rename: (from, to) => Effect.gen(function* () {
             if (from === folder && boundary === "record") yield* gate;
             yield* fs.rename(from, to);
             if (from === folder && boundary === "move") yield* gate;
           }),
           chmod: (path, mode) => Effect.gen(function* () {
             if (path === home + "/library.sqlite" && boundary === "step") {
               const snapshot = yield* inspectLocalLibraryState(home);
               if (snapshot.present && (yield* loadOperations(home)).some((operation) =>
                 operation._tag === "Pending" && operation.steps[0]?.status === "Done")) yield* gate;
             }
             yield* fs.chmod(path, mode);
           }) };

       }));
       const roots = { home: home + "/device-home", configHome: home + "/device-home/.config", overrides: {} };
       const layer = Library.layer({ home, roots }).pipe(
         Layer.provide(paused));
       const keepAlive = setInterval(() => {}, 60_000);
       try { await Effect.runPromise(Effect.gen(function* () {
         const library = Context.get(yield* Layer.build(layer), Library.Service);
         const evidence = yield* readPathEvidence(folder);
         if (Option.isNone(evidence)) return yield* Effect.die("no folder");
         const base = yield* library.read;
         yield* library.setup([{ _tag: "Remove", folders: [evidence.value] }], { base });
       }).pipe(Effect.provide(skitLayer), Effect.scoped));
       } finally { clearInterval(keepAlive); }`,
      folderEvidence,
      home,
      folder,
      boundary,
    ],
    { cwd: dirname(dirname(fileURLToPath(import.meta.url))), stdout: "pipe", stderr: "inherit" },
  );

/** Run setup in another process and SIGKILL it at a recorded durability boundary. */
const killedAfter = Effect.fn("Test.killedAfter")(function* (
  home: string,
  folder: string,
  boundary: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(setupProcess(home, folder, boundary));
  const readiness = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.take(1),
    Stream.runCollect,
  );
  assert.deepStrictEqual(readiness, ["paused"]);
  assert.isTrue(yield* child.isRunning);
  yield* child.kill({ killSignal: "SIGKILL" });
  const exit = yield* Effect.result(child.exitCode);
  assert.strictEqual(exit._tag, "Failure");
  if (exit._tag === "Failure") assert.include(String(exit.failure.cause), "SIGKILL");
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-startup-" });
  const home = join(workspace, "home");
  const folder = join(workspace, "skills", "review");
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(join(folder, "SKILL.md"), "---\nname: review\n---\nReview.\n");
  return { fs, home, folder };
});

/** The stored operation records, read without building an owner, which would recover them. */
const recordedOperations = (home: string) =>
  Effect.gen(function* () {
    const inspected = yield* inspectLocalLibraryState(home);
    return inspected.present ? yield* loadOperations(home) : [];
  });

/** Build the Library over `home`, as the next SKIT run does, and what its startup did. */
const startup = (home: string) =>
  Effect.map(
    Layer.build(libraryLayer(home)),
    (built) => Context.get(built, Library.Service).startup,
  );

it.effect("with nothing Pending, building the layer takes no lock and writes nothing", () =>
  Effect.gen(function* () {
    const { home, folder } = yield* fixture;
    const finished = yield* Effect.scoped(
      Effect.flatMap(Layer.build(libraryLayer(home)), (built) => {
        const library = Context.get(built, Library.Service);
        return Effect.flatMap(readPathEvidence(folder), (evidence) =>
          Option.isNone(evidence)
            ? Effect.die("no folder")
            : Effect.flatMap(library.read, (base) =>
                library.setup([{ _tag: "Remove", folders: [evidence.value] }], { base }),
              ),
        );
      }),
    );
    assert.strictEqual(finished._tag, "Done");
    const before = yield* inspectLocalLibraryState(home);
    // Another holder, as another process would be: a build that took the lock would fail.
    yield* lockFile(join(home, "lock.sqlite"));

    assert.deepStrictEqual(yield* startup(home), { finished: [], stopped: [] });
    assert.deepStrictEqual(yield* inspectLocalLibraryState(home), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

describe("skit setup", () => {
  describe("Keeping files recoverable", () => {
    describe("An interrupted setup keeps the remaining files recoverable.", () => {
      // A one-folder removal commits the record, the receipt, the move, the Done mark, then Done.
      for (const [boundary, after] of [
        ["record", "the record"],
        ["move", "the move"],
        ["step", "the Done mark"],
      ] as const)
        it.effect(`a setup killed after ${after} is finished when the layer is next built`, () =>
          Effect.gen(function* () {
            const { fs, home, folder } = yield* fixture;
            yield* killedAfter(home, folder, boundary);
            const [operation] = yield* recordedOperations(home);
            if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");

            assert.deepStrictEqual(yield* startup(home), {
              finished: [operation.operationId],
              stopped: [],
            });
            assert.isFalse(yield* fs.exists(folder));
            assert.isTrue(
              yield* fs.exists(join(home, "removed", operation.operationId, "step-1", "1-review")),
            );
            assert.deepStrictEqual(
              (yield* recordedOperations(home)).map(({ _tag, operationId }) => ({
                _tag,
                operationId,
              })),
              [{ _tag: "Done", operationId: operation.operationId }],
            );
          }).pipe(Effect.provide(skitLayer), Effect.scoped),
        );

      it.effect(
        "a setup whose folder changed after it was killed stops, and the layer still builds",
        () =>
          Effect.gen(function* () {
            const { fs, home, folder } = yield* fixture;
            yield* killedAfter(home, folder, "record");
            yield* fs.writeFileString(join(folder, "notes.md"), "the user's edit\n");
            const [operation] = yield* recordedOperations(home);
            if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");

            const recovered = yield* startup(home);

            assert.deepStrictEqual(recovered.finished, []);
            const [stopped] = recovered.stopped;
            assert.strictEqual(stopped?.operationId, operation.operationId);
            assert.strictEqual(stopped?.reason._tag, "EvidenceDiffers");
            assert.deepStrictEqual(
              (yield* recordedOperations(home)).map((record) => ({
                _tag: record._tag,
                operationId: record.operationId,
              })),
              recovered.stopped.map((record) => ({
                _tag: record._tag,
                operationId: record.operationId,
              })),
            );
            assert.strictEqual(
              yield* fs.readFileString(join(folder, "notes.md")),
              "the user's edit\n",
            );
            // Stopped is settled: the next build finds nothing to recover.
            assert.deepStrictEqual(yield* startup(home), { finished: [], stopped: [] });
          }).pipe(Effect.provide(skitLayer), Effect.scoped),
      );
    });
  });
});

for (const boundary of ["before-publication", "before-stub"])
  it.effect(`restarts a SIGKILLed import ${boundary} with released files intact`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-killed-" });
      const original = JSON.stringify({
        schemaVersion: 9,
        unmanaged: [],
        collections: [],
        skills: [],
        retained_copies: [],
        acquisitions: [],
        global_bindings: [],
        local_bindings: [],
        projections: [],
      });
      yield* fs.writeFileString(join(home, "state.json"), original);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { Effect, FileSystem, Layer } from "effect";
         import { skitLayer } from "@smolai/skit-core/platform";
         const [url, home, boundary] = process.argv.slice(1);
         const { migrateLocalLibraryState } = await import(new URL("./store/state-file.js", url));
         const paused = Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, fs => {
           const gate = Effect.andThen(Effect.sync(() => process.stdout.write("paused\\n")), Effect.never);
           return { ...fs,
             link: (from, to) => Effect.gen(function* () {
               if (to === home + "/library.sqlite" && boundary === "before-publication") yield* gate;
               yield* fs.link(from, to);
             }),
             rename: (from, to) => Effect.gen(function* () {
               if (to === home + "/state.json" && boundary === "before-stub") yield* gate;
               yield* fs.rename(from, to);
             }),
           };
         }));
         const keepAlive = setInterval(() => {}, 60_000);
         try { await Effect.runPromise(migrateLocalLibraryState(home).pipe(
           Effect.provide(paused), Effect.provide(skitLayer)));
         } finally { clearInterval(keepAlive); }`,
            folderEvidence,
            home,
            boundary,
          ],
          {
            cwd: dirname(dirname(fileURLToPath(import.meta.url))),
            stdout: "pipe",
            stderr: "inherit",
          },
        ),
      );
      const readiness = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      );
      assert.deepStrictEqual(readiness, ["paused"]);
      yield* child.kill({ killSignal: "SIGKILL" });
      yield* Effect.result(child.exitCode);
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), original);
      assert.strictEqual(yield* fs.exists(join(home, ".lock")), boundary === "before-stub");
      assert.strictEqual(
        yield* fs.exists(join(home, "library.sqlite")),
        boundary === "before-stub",
      );
      yield* migrateLocalLibraryState(home);
      const state = yield* inspectLocalLibraryState(home);
      assert.isTrue(state.present);
      if (state.present) assert.deepStrictEqual(yield* loadOperations(home), []);
      assert.isFalse(yield* fs.exists(join(home, ".lock")));
      assert.notStrictEqual(yield* fs.readFileString(join(home, "state.json")), original);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
