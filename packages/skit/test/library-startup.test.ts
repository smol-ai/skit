import { assert, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPathEvidence } from "../src/library/folder-evidence.js";
import * as Library from "../src/library/library.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
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
 * (commits + 1)th rename or link, saying so, to be killed there: everything before it is on disk.
 */
const setupProcess = (home: string, folder: string, commits: number) =>
  ChildProcess.make(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { Context, Effect, FileSystem, Layer, Option } from "effect";
       import * as Library from "@smolai/skit-core/library";
       import { skitLayer } from "@smolai/skit-core/platform";
       const [url, home, folder, commits] = process.argv.slice(1);
       const { readPathEvidence } = await import(url);
       const paused = Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, (fs) => {
         let left = Number(commits);
         const gate = Effect.suspend(() => left-- > 0 ? Effect.void
           : Effect.andThen(Effect.sync(() => process.stdout.write("paused\\n")), Effect.never));
         return { ...fs,
           rename: (from, to) => Effect.andThen(gate, fs.rename(from, to)),
           link: (from, to) => Effect.andThen(gate, fs.link(from, to)) };
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
      String(commits),
    ],
    { cwd: dirname(dirname(fileURLToPath(import.meta.url))), stdout: "pipe", stderr: "inherit" },
  );

/** Run setup in another process and SIGKILL it once it has made `commits` durable writes. */
const killedAfter = Effect.fn("Test.killedAfter")(function* (
  home: string,
  folder: string,
  commits: number,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(setupProcess(home, folder, commits));
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

/** The operation records in `state.json`, read as a file: building a store would recover them. */
const recordedOperations = (home: string) =>
  Effect.gen(function* () {
    const inspected = yield* inspectLocalLibraryState(home);
    return inspected.present
      ? yield* Schema.decodeEffect(Schema.Array(OperationStatus))(inspected.state.operations)
      : [];
  });

/** Build the Library over `home`, as the next SKIT run does, and what its startup did. */
const startup = (home: string) =>
  Effect.map(
    Layer.build(libraryLayer(home)),
    (built) => Context.get(built, Library.Service).startup,
  );

// A one-folder removal commits the record, the receipt, the move, the Done mark, then Done.
for (const [commits, after] of [
  [1, "the record"],
  [3, "the move"],
  [4, "the Done mark"],
] as const)
  it.effect(`a setup killed after ${after} is finished when the layer is next built`, () =>
    Effect.gen(function* () {
      const { fs, home, folder } = yield* fixture;
      yield* killedAfter(home, folder, commits);
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
        (yield* recordedOperations(home)).map(({ _tag, operationId }) => ({ _tag, operationId })),
        [{ _tag: "Done", operationId: operation.operationId }],
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "a setup whose folder changed after it was killed stops, and the layer still builds",
  () =>
    Effect.gen(function* () {
      const { fs, home, folder } = yield* fixture;
      yield* killedAfter(home, folder, 2);
      yield* fs.writeFileString(join(folder, "notes.md"), "the user's edit\n");
      const [operation] = yield* recordedOperations(home);
      if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");

      const recovered = yield* startup(home);

      assert.deepStrictEqual(recovered.finished, []);
      const [stopped] = recovered.stopped;
      assert.strictEqual(stopped?.operationId, operation.operationId);
      assert.strictEqual(stopped?.reason._tag, "EvidenceDiffers");
      assert.deepStrictEqual(yield* recordedOperations(home), recovered.stopped);
      assert.strictEqual(yield* fs.readFileString(join(folder, "notes.md")), "the user's edit\n");
      // Stopped is settled: the next build finds nothing to recover.
      assert.deepStrictEqual(yield* startup(home), { finished: [], stopped: [] });
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("with nothing Pending, building the layer takes no lock and writes nothing", () =>
  Effect.gen(function* () {
    const { fs, home, folder } = yield* fixture;
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
    const before = yield* fs.readFileString(join(home, "state.json"));
    // Another holder, as another process would be: a build that took the lock would fail.
    yield* lockFile(join(home, "lock.sqlite"));

    assert.deepStrictEqual(yield* startup(home), { finished: [], stopped: [] });
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
