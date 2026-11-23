import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Library from "../src/library/library.js";
import * as MachineSettings from "../src/library/machine-settings.js";
import { loadLibrary, loadOperations } from "../src/library/store/library-store.js";
import { canonicalJson } from "../src/shared/json.js";
import { skitLayer } from "../src/platform/layer.js";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(packageRoot, "test/fixtures/library-setup-machine-process.ts");
for (const point of [
  "setup-progress",
  "setup-before",
  "setup-after",
  "undo-before",
  "undo-after",
]) {
  it.effect(
    "SIGKILL at " + point + " keeps Library, settings and setup completion consistent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-machine-kill-" }),
        );
        const home = join(root, "library"),
          skills = join(root, "skills"),
          copy = join(skills, "review");
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const init = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [script, root, "init"], {
            cwd: packageRoot,
            stderr: "inherit",
          }),
        );
        assert.strictEqual(Number(yield* init.exitCode), 0);
        const original = yield* loadLibrary(home),
          settingsBefore = yield* MachineSettings.read(home);
        const bytes = yield* fs.readFileString(join(copy, "SKILL.md"));
        if (point.startsWith("undo-")) {
          const prepare = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [script, root, "prepare"], {
              cwd: packageRoot,
              stderr: "inherit",
            }),
          );
          assert.strictEqual(Number(yield* prepare.exitCode), 0);
        }
        const before = yield* loadLibrary(home),
          machine = yield* MachineSettings.read(home);
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [script, root, point], {
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
        const message = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              kind: Schema.Literal("paused"),
              point: Schema.String,
              operationId: Schema.String,
            }),
          ),
        )(lines[0] ?? "");
        assert.strictEqual(message.point, point);
        yield* child.kill({ killSignal: "SIGKILL" });
        const exit = yield* Effect.result(child.exitCode);
        assert.strictEqual(exit._tag, "Failure");
        if (exit._tag === "Failure") assert.include(String(exit.failure.cause), "SIGKILL");
        const records = yield* loadOperations(home),
          target = records.find((row) => row.operationId === message.operationId);
        assert.ok(target);
        const interrupted = yield* loadLibrary(home),
          settings = yield* MachineSettings.read(home);
        if (point === "undo-before") {
          assert.strictEqual(target._tag, "Done");
          assert.strictEqual(canonicalJson(interrupted), canonicalJson(before));
          assert.deepStrictEqual(settings, machine);
        }
        if (point === "undo-after") {
          assert.strictEqual(target._tag, "Undone");
          assert.strictEqual(canonicalJson(interrupted), canonicalJson(original));
          assert.deepStrictEqual(settings, settingsBefore);
        }
        if (point === "setup-after") {
          assert.strictEqual(target._tag, "Done");
          assert.deepStrictEqual(settings.discoveryRoots, [join(root, "after")]);
        }
        if (point === "setup-before" || point === "setup-progress") {
          assert.strictEqual(target._tag, "Pending");
          assert.deepStrictEqual(settings, settingsBefore);
          assert.strictEqual(interrupted.enabled.length, 1);
        }
        const pending = records
          .filter((row) => row._tag === "Pending")
          .map((row) => row.operationId);
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          assert.deepStrictEqual(library.startup.finished, pending);
          assert.deepStrictEqual(library.startup.stopped, []);
        }).pipe(
          Effect.provide(
            Library.layer({
              home,
              roots: { home: root, configHome: root, overrides: { codex: [skills] } },
            }),
          ),
        );
        const final = yield* loadLibrary(home),
          done = (yield* loadOperations(home)).find(
            (row) => row.operationId === message.operationId,
          );
        assert.strictEqual(yield* fs.readFileString(join(copy, "SKILL.md")), bytes);
        if (point.startsWith("undo-")) {
          assert.strictEqual(done?._tag, "Undone");
          assert.strictEqual(canonicalJson(final), canonicalJson(original));
          assert.deepStrictEqual(yield* MachineSettings.read(home), settingsBefore);
          assert.isFalse(yield* fs.exists(join(copy, ".skit-ownership.json")));
        } else {
          assert.strictEqual(done?._tag, "Done");
          assert.deepStrictEqual(final.enabled, [{ skill: original.skills[0]!.skill_id }]);
          assert.strictEqual(final.installed_skills.length, 1);
          assert.strictEqual(final.installed_skills[0]?.status, "installed");
          assert.isTrue(yield* fs.exists(join(copy, ".skit-ownership.json")));
          assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, [
            join(root, "after"),
          ]);
          const { enabled: _enabled, installed_skills: _installed, ...kept } = final;
          const { enabled: _priorEnabled, installed_skills: _priorInstalled, ...prior } = original;
          assert.strictEqual(canonicalJson(kept), canonicalJson(prior));
        }
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}
