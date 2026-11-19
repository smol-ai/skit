import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Library from "../src/library/library.js";
import { InstalledApply } from "../src/library/store/state-schema.js";
import { loadLibrary, loadOperations } from "../src/library/store/library-store.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
for (const mode of ["enable", "remove", "setup", "sync", "remove-done"])
  it.effect("SIGKILL " + mode + " resumes its recorded Apply without Library copies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-apply-kill-" }),
      );
      const home = join(root, "library");
      const child = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
        ChildProcess.make(
          process.execPath,
          [join(packageRoot, "test/fixtures/library-apply-process.ts"), root, mode],
          { cwd: packageRoot, stdout: "pipe", stderr: "inherit" },
        ),
      );
      const lines = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(lines.length, 1);
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(lines[0] ?? ""),
        { kind: "paused", mode },
      );
      assert.isTrue(yield* child.isRunning);
      yield* child.kill({ killSignal: "SIGKILL" });
      const exit = yield* Effect.result(child.exitCode);
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure") assert.include(String(exit.failure.cause), "SIGKILL");
      const operation = (yield* loadOperations(home)).find(
        (operation) => operation._tag === "Pending",
      );
      if (operation?._tag !== "Pending") return assert.fail("Missing operation");
      const applies = operation.steps.flatMap((step) => [
        ...(step.step._tag === "Apply" ? [step.step] : []),
        ...(step.applies ?? []).map(({ apply }) => apply),
      ]);
      assert.isNotEmpty(applies);
      if (mode === "setup" || mode === "sync")
        assert.isTrue(operation.steps.some((step) => (step.applies?.length ?? 0) > 0));
      for (const apply of applies) {
        assert.isTrue(Schema.is(InstalledApply)(apply));
        assert.isFalse(Object.hasOwn(apply, "before"));
        assert.isFalse(Object.hasOwn(apply, "next"));
      }
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.deepStrictEqual(library.startup.finished, [operation.operationId]);
        assert.deepStrictEqual(library.startup.stopped, []);
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
      const state = yield* loadLibrary(home);
      if (mode.startsWith("remove")) {
        assert.deepStrictEqual(state.collections, []);
        assert.deepStrictEqual(state.skills, []);
        assert.deepStrictEqual(state.installed_skills, []);
        assert.isFalse(yield* fs.exists(join(root, "skills/review")));
      } else {
        assert.strictEqual(state.installed_skills[0]?.status, "installed");
        assert.include(
          yield* fs.readFileString(join(root, "skills/review/SKILL.md")),
          mode === "setup" ? "Updated" : "Original",
        );
      }
      assert.include(
        yield* fs.readFileString(join(root, "source/SKILL.md")),
        mode === "setup" ? "Updated" : "Original",
      );
      if (mode === "remove")
        assert.deepStrictEqual(yield* fs.readDirectory(join(root, ".skit-backups")), [
          ".gitignore",
        ]);
      if (mode === "remove-done") {
        const names = yield* fs.readDirectory(join(root, ".skit-backups"));
        assert.isFalse(names.some((name) => name.startsWith("pending-")));
        const kept = names.find((name) => name.startsWith("kept-"));
        assert.ok(kept);
        assert.include(
          yield* fs.readFileString(join(root, ".skit-backups", kept, "SKILL.md")),
          "Original",
        );
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
