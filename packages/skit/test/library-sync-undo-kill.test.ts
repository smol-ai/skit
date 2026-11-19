import { assert, it } from "@effect/vitest";
import { Clock, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Library from "../src/library/library.js";
import { loadLibrary, loadOperations } from "../src/library/store/library-store.js";
import { canonicalJson } from "../src/shared/json.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
for (const mode of ["sync-retire", "sync-save", "sync-install", "undo"])
  it.effect("SIGKILL " + mode + " reaches the uninterrupted Library and folder result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const clock = yield* Clock.Clock;
      const fixedClock: Clock.Clock = {
        currentTimeMillis: Effect.succeed(1_800_000_000_000),
        currentTimeMillisUnsafe: () => 1_800_000_000_000,
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: (duration) => clock.sleep(duration),
      };
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-undo-kill-" }),
      );
      const root = join(directory, "device");
      const home = join(root, "library");
      const script = join(packageRoot, "test/fixtures/library-row-process.ts");
      const init = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [script, "sync-undo", root, "init"], {
          cwd: packageRoot,
          stderr: "inherit",
        }),
      );
      assert.strictEqual(Number(yield* init.exitCode), 0);
      const saved = join(directory, "saved");
      yield* fs.copy(root, saved);
      const uninterrupted = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [script, "sync-undo", root, mode, "uninterrupted"], {
          cwd: packageRoot,
          stderr: "inherit",
        }),
      );
      assert.strictEqual(Number(yield* uninterrupted.exitCode), 0);
      const expected = yield* loadLibrary(home);
      const expectedBytes = yield* fs.readFileString(join(root, "skills/review/SKILL.md"));
      yield* fs.remove(root, { recursive: true });
      yield* fs.copy(saved, root);
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [script, "sync-undo", root, mode, "kill"], {
          cwd: packageRoot,
          stdout: "pipe",
          stderr: "inherit",
        }),
      );
      const lines = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      );
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(lines[0] ?? ""),
        { kind: "paused", mode },
      );
      yield* child.kill({ killSignal: "SIGKILL" });
      const exit = yield* Effect.result(child.exitCode);
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure") assert.include(String(exit.failure.cause), "SIGKILL");
      const pending = (yield* loadOperations(home)).find((x) => x._tag === "Pending");
      if (pending?._tag !== "Pending") return assert.fail("Missing pending operation");
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.deepStrictEqual(library.startup.finished, [pending.operationId]);
        assert.deepStrictEqual(library.startup.stopped, []);
      }).pipe(
        Effect.provide(Library.layer({ home, roots: testRoots(home) })),
        Effect.provideService(Clock.Clock, fixedClock),
      );
      const actual = yield* loadLibrary(home);
      const { installed_skills: expectedInstalled, ...expectedBody } = expected;
      const { installed_skills: actualInstalled, ...actualBody } = actual;
      assert.strictEqual(canonicalJson(actualBody), canonicalJson(expectedBody));
      // The seed fixes identity; the same clock also fixes timestamps on resumed installs.
      assert.strictEqual(canonicalJson(actualInstalled), canonicalJson(expectedInstalled));
      assert.strictEqual(
        yield* fs.readFileString(join(root, "skills/review/SKILL.md")),
        expectedBytes,
      );
      assert.include(yield* fs.readFileString(join(root, "source/SKILL.md")), "Updated");
      if (mode === "undo")
        for (const name of ["first", "second"])
          assert.strictEqual(yield* fs.readFileString(join(root, name, "SKILL.md")), name);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
