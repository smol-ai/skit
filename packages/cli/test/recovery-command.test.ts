import { basename, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { skitLayer } from "@smolai/skit-core";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { prepareRecoveryMoves } from "../src/library-application/recovery-moves.js";
import { deterministicTreeHashEffect, scratch } from "./helpers/library-home.js";

const invoke = Effect.fn("Test.recoveryCommand")(function* (argv: readonly string[]) {
  const interaction = yield* makeScriptedInteraction([]);
  yield* runCommandTree(skitCommand, argv.slice(1), "test").pipe(Effect.provide(interaction.layer));
  expect(yield* interaction.failures).toEqual([]);
  const results = yield* interaction.results;
  expect(results).toHaveLength(1);
  return results[0];
});

it.effect("a client follows returned actions through the real grammar to restore files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-recovery-command-");
    const home = join(root, "chosen home");
    const source = join(root, "installed");
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(join(source, "SKILL.md"), "preserve me");
    const plan = yield* prepareRecoveryMoves(home, [
      { name: "review", path: source, observedHash: yield* deterministicTreeHashEffect(source) },
    ]);
    yield* plan.apply();
    let response = yield* invoke(["skit", "library", "recovery", "list", "--json", "--home", home]);
    if (response.contract !== "recoveryList")
      return yield* Effect.die(new Error("Expected a recovery list"));
    expect(response.data.operations[0].operationId).toBe(basename(plan.operationDirectory));
    let action = response.data.operations[0].actions[0];
    const followed: string[] = [];
    for (let step = 0; step < 3; step++) {
      followed.push(action.rel);
      expect(action.argv).toContain(home);
      response = yield* invoke(action.argv);
      if (response.contract !== "recovery")
        return yield* Effect.die(new Error("Expected recovery facts"));
      const rendered = renderContract(response, { color: false, detail: "full" });
      expect(rendered).toContain("File recovery:");
      expect(rendered).toContain("Library bindings and settings are unchanged");
      const data = response.data;
      const next = data.actions.find(
        (candidate) =>
          candidate.rel === (data.phase === "inspection" ? "preview-restore" : "apply-restore"),
      );
      if (step < 2) {
        if (!next) return yield* Effect.die(new Error("Missing continuation"));
        action = next;
      }
    }
    expect(followed).toEqual(["inspect", "preview-restore", "apply-restore"]);
    expect(response.contract === "recovery" && response.data.phase).toBe("restored");
    expect(yield* fs.readFileString(join(source, "SKILL.md"))).toBe("preserve me");
    expect(yield* fs.exists(join(home, "state.json"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a stale argv cannot apply and an occupied destination has no advertised apply action",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-recovery-stale-command-");
      const home = join(root, "library");
      const source = join(root, "installed");
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(join(source, "SKILL.md"), "old bytes");
      const plan = yield* prepareRecoveryMoves(home, [
        { name: "review", path: source, observedHash: yield* deterministicTreeHashEffect(source) },
      ]);
      yield* plan.apply();
      const preview = yield* invoke([
        "skit",
        "library",
        "recovery",
        "restore",
        basename(plan.operationDirectory),
        "--home",
        home,
        "--json",
      ]);
      if (preview.contract !== "recovery") return yield* Effect.die(new Error("Expected preview"));
      const apply = preview.data.actions.find((action) => action.rel === "apply-restore");
      if (!apply) return yield* Effect.die(new Error("Expected apply"));
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(join(source, "SKILL.md"), "new user edit");
      const stale = yield* invoke(apply.argv);
      if (stale.contract !== "recovery")
        return yield* Effect.die(new Error("Expected stale result"));
      expect(stale.exitCode).toBe(12);
      expect(stale.data.phase).toBe("stale");
      expect(stale.data.actions.map((action) => action.rel)).toEqual([
        "inspect",
        "preview-restore",
      ]);
      const refreshed = yield* invoke(stale.data.actions[1].argv);
      if (refreshed.contract !== "recovery")
        return yield* Effect.die(new Error("Expected refreshed preview"));
      expect(refreshed.data.actions.some((action) => action.effect === "write")).toBe(false);
      expect(yield* fs.readFileString(join(source, "SKILL.md"))).toBe("new user edit");
      expect(
        yield* fs.readFileString(join(refreshed.data.entries[0].recoveryPath, "SKILL.md")),
      ).toBe("old bytes");
    }).pipe(Effect.provide(skitLayer)),
);
