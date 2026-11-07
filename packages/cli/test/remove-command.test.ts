import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Layer, ConfigProvider, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { runCommandTree } from "../src/commands/runtime.js";
import { skitCommand } from "../src/commands/tree.js";
import type { CommandFailure, CommandResult } from "../src/commands/types.js";
import { copySkitFixtureEffect } from "./helpers/library-home.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("remove uses its parsed home and removes recorded copies after a passive preview", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-remove-command-" });
    const home = join(root, "selected");
    const ignored = join(root, "environment");
    const source = join(root, "source");
    const installed = join(root, "installed");
    yield* copySkitFixtureEffect("authored", source);
    yield* fs.makeDirectory(ignored);
    yield* fs.writeFileString(join(ignored, "state.json"), "invalid unselected Library");
    const failures: CommandFailure[] = [];
    const results: CommandResult[] = [];
    const run = (args: readonly string[]) =>
      runCommandTree(skitCommand, [...args, "--home", home, "--json"], "test").pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: ignored })).pipe(
            Layer.provideMerge(
              rendererTestLayer({
                failure: (failure) =>
                  Effect.sync(() => {
                    failures.push(failure);
                  }),
                result: (result) =>
                  Effect.sync(() => {
                    results.push(result);
                  }),
              }),
            ),
          ),
        ),
      );
    yield* run(["add", source]);
    yield* run(["enable", "review", "--global", "--codex-root", installed]);
    assert.deepStrictEqual(failures, []);
    const skill = join(installed, "review", "SKILL.md");
    const before = yield* fs.readFileString(join(home, "state.json"));
    const bytes = yield* fs.readFileString(skill);

    yield* run(["remove", "review", "--dry-run"]);
    assert.strictEqual(results.at(-1)?.contract, "removePlan");
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
    assert.strictEqual(yield* fs.readFileString(skill), bytes);

    // Removal follows recorded copies even when this invocation names a different device root.
    const otherRoot = join(root, "other-root");
    yield* run(["remove", "review", "--codex-root", otherRoot]);
    assert.deepStrictEqual(failures, []);
    assert.strictEqual(results.at(-1)?.contract, "remove");
    assert.isFalse(yield* fs.exists(skill));
    assert.isFalse(yield* fs.exists(otherRoot));
    assert.strictEqual(
      yield* fs.readFileString(join(ignored, "state.json")),
      "invalid unselected Library",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "remove help and invalid arguments skip Library acquisition; startup failures render once",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-remove-startup-" });
      yield* fs.writeFileString(join(home, "state.json"), "invalid selected Library");
      const failures: CommandFailure[] = [];
      const run = (args: readonly string[]) =>
        runCommandTree(skitCommand, ["remove", ...args, "--home", home], "test").pipe(
          Effect.provide(
            rendererTestLayer({
              failure: (failure) =>
                Effect.sync(() => {
                  failures.push(failure);
                }),
            }),
          ),
        );
      yield* run(["--help"]);
      assert.deepStrictEqual(failures, []);
      yield* run([]);
      assert.deepStrictEqual(
        failures.map((failure) => failure.code),
        ["INVALID_ARGUMENT"],
      );
      failures.length = 0;

      yield* run(["review"]);
      assert.deepStrictEqual(
        failures.map((failure) => failure.code),
        ["VALIDATION_FAILED"],
      );
      assert.strictEqual(
        yield* fs.readFileString(join(home, "state.json")),
        "invalid selected Library",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
