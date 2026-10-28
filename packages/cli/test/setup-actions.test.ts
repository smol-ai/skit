import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { MachineSettings, skitLayer } from "@smolai/skit-core";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import type { CommandAction } from "../src/commands/command-actions.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { scratch } from "./helpers/library-home.js";

const invoke = Effect.fn("Test.setupAction")(function* (argv: readonly string[]) {
  const interaction = yield* makeScriptedInteraction([]);
  yield* runCommandTree(skitCommand, argv.slice(1), "test").pipe(Effect.provide(interaction.layer));
  expect(yield* interaction.failures).toEqual([]);
  const results = yield* interaction.results;
  expect(results).toHaveLength(1);
  return results[0];
});
const actionFor = (actions: readonly CommandAction[], rel: string) => {
  const action = actions.find((item) => item.rel === rel);
  expect(action, `Missing ${rel}`).toBeDefined();
  if (!action) throw new Error(`Missing ${rel}`);
  return action;
};
const fixture = Effect.fn("Test.setupActionFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-setup-actions-"));
  const home = join(root, "chosen home");
  const agents = join(root, "agents");
  const claude = join(root, "claude");
  const source = join(agents, "review");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: review fixture\n---\n\nOriginal review bytes.\n",
  );
  return {
    fs,
    home,
    root,
    agents,
    claude,
    source,
    argv: [
      "skit",
      "setup",
      "--json",
      "--home",
      home,
      "--codex-root",
      agents,
      "--claude-root",
      claude,
      "--opencode-root",
      join(root, "opencode"),
    ],
  };
});

it.effect(
  "a generic client follows discover, review and apply actions into the selected active state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const discovery = yield* invoke(f.argv);
      if (discovery.contract !== "setup")
        return yield* Effect.die(new Error("Expected setup discovery"));
      const copy = discovery.data.choices.find(
        (choice) => choice.kind === "copy" && choice.path === f.source,
      );
      expect(copy).toBeDefined();
      if (!copy) return yield* Effect.die(new Error("Expected a selectable copy"));
      expect(yield* f.fs.exists(f.home)).toBe(false);
      const review = yield* invoke(actionFor(copy.actions, "review").argv);
      if (review.contract !== "setupReview")
        return yield* Effect.die(new Error("Expected setup review"));
      expect(review.data.summary.enables).toContainEqual({ name: "review", path: f.source });
      expect(yield* f.fs.exists(f.home)).toBe(false);
      const apply = actionFor(review.data.actions, "apply");
      expect(apply.argv).toContain(f.home);
      expect(apply.argv).toContain(f.agents);
      expect(apply.argv).toContain(f.claude);
      expect(apply.argv).toContain(review.data.reviewId);
      expect(apply.argv.every((word) => !word.includes("\0") && !word.includes("<"))).toBe(true);
      const result = yield* invoke(apply.argv);
      if (result.contract !== "setupApplied")
        return yield* Effect.die(new Error("Expected applied setup"));
      expect(result.data.added).toEqual([{ name: "review", sourcePath: f.source }]);
      expect(result.data.installedSkills.length).toBeGreaterThan(0);
      expect(
        result.data.installedSkills.every((projection) => projection.status === "installed"),
      ).toBe(true);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain(
        "Original review bytes",
      );
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toContain(
        "Original review bytes",
      );
      expect(result.data.actions.some((action) => action.rel === "observe")).toBe(true);
      expect(result.data.actions.some((action) => action.rel === "list-recovery")).toBe(true);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("stale actions fail with continuations and never enable a changed copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const discovery = yield* invoke(f.argv);
    if (discovery.contract !== "setup") return yield* Effect.die(new Error("Expected setup"));
    const selected = discovery.data.choices.find(
      (choice) => choice.kind === "copy" && choice.path === f.source,
    );
    if (!selected) return yield* Effect.die(new Error("Expected a selectable copy"));
    const review = yield* invoke(actionFor(selected.actions, "review").argv);
    if (review.contract !== "setupReview") return yield* Effect.die(new Error("Expected review"));
    const apply = actionFor(review.data.actions, "apply");
    yield* f.fs.writeFileString(
      join(f.source, "SKILL.md"),
      "---\nname: review\ndescription: changed\n---\n\nNewer edit\n",
    );
    const failed = yield* invoke(apply.argv);
    if (failed.contract !== "setupFailed")
      return yield* Effect.die(new Error("Expected actionable failure"));
    expect(failed.exitCode).toBe(12);
    expect(failed.data.actions.map((action) => action.rel)).toEqual(["observe", "list-recovery"]);
    expect(yield* f.fs.exists(join(f.home, "state.json"))).toBe(false);
    expect(yield* f.fs.exists(join(f.claude, "review"))).toBe(false);
    const refreshed = yield* invoke(actionFor(failed.data.actions, "observe").argv);
    expect(refreshed.contract).toBe("setup");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "explicit removal has a passive review, preserves bytes and advertises recovery inspection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const discovery = yield* invoke(f.argv);
      if (discovery.contract !== "setup") return yield* Effect.die(new Error("Expected setup"));
      const removal = discovery.data.choices.find(
        (choice) => choice.kind === "removal" && choice.path === f.source,
      );
      if (!removal) return yield* Effect.die(new Error("Expected a removable copy"));
      const review = yield* invoke(actionFor(removal.actions, "review").argv);
      if (review.contract !== "setupReview") return yield* Effect.die(new Error("Expected review"));
      expect(review.data.summary.enables).toEqual([]);
      expect(yield* f.fs.exists(f.source)).toBe(true);
      const applied = yield* invoke(actionFor(review.data.actions, "apply").argv);
      if (applied.contract !== "setupApplied")
        return yield* Effect.die(new Error("Expected applied setup"));
      expect(applied.data.removed).toEqual([{ name: "review", path: f.source }]);
      expect(applied.data.leftAlone.some((copy) => copy.name === "review")).toBe(false);
      expect(yield* f.fs.exists(f.source)).toBe(false);
      expect(applied.data.installedSkills).toEqual([]);
      const recovered = yield* invoke(actionFor(applied.data.actions, "inspect-recovery").argv);
      if (recovered.contract !== "recovery")
        return yield* Effect.die(new Error("Expected recovery inspection"));
      expect(recovered.data.entries[0].status).toBe("saved");
      expect(
        yield* f.fs.readFileString(join(recovered.data.entries[0].recoveryPath, "SKILL.md")),
      ).toContain("Original review bytes");
      expect(yield* f.fs.exists(join(f.home, "state.json"))).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "mixed duplicate facts advertise only alternatives valid for the entire recommendation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const linkedSource = join(f.root, "source", "linked");
      yield* f.fs.makeDirectory(linkedSource, { recursive: true });
      yield* f.fs.writeFileString(
        join(linkedSource, "SKILL.md"),
        "---\nname: linked\ndescription: linked fixture\n---\n\nLinked contents\n",
      );
      yield* f.fs.symlink(linkedSource, join(f.agents, "linked"));
      yield* f.fs.makeDirectory(f.claude, { recursive: true });
      yield* f.fs.symlink(linkedSource, join(f.claude, "linked"));
      // An ordinary copied directory elsewhere cannot be retired as a link.
      const oldRoot = join(f.root, "legacy");
      yield* f.fs.makeDirectory(oldRoot);
      yield* f.fs.copy(f.source, join(oldRoot, "review"));
      const discovery = yield* invoke([
        ...f.argv,
        "--devin-root",
        f.agents,
        "--devin-root",
        oldRoot,
      ]);
      if (discovery.contract !== "setup") return yield* Effect.die(new Error("Expected setup"));
      const linked = discovery.data.choices.find(
        (choice) => choice.kind === "copy" && choice.label === "linked",
      );
      if (!linked) return yield* Effect.die(new Error("Expected linked choice"));
      expect(linked.duplicateActions).toEqual([]);
      const recommended = discovery.data.actions.filter((action) => action.rel === "review");
      expect(recommended.length).toBeGreaterThan(0);
      let reviewedApply: readonly string[] | undefined;
      for (const action of recommended) {
        const index = action.argv.indexOf("--duplicates");
        expect(index).toBe(-1);
        const accepted = yield* invoke(action.argv);
        expect(accepted.contract).toBe("setupReview");
        if (accepted.contract === "setupReview")
          expect(accepted.data.summary.preserves.some((entry) => entry.kind === "directory")).toBe(
            true,
          );
        if (accepted.contract === "setupReview")
          reviewedApply = accepted.data.actions.find((next) => next.rel === "apply")?.argv;
      }
      expect(yield* f.fs.exists(join(f.home, "state.json"))).toBe(false);
      if (!reviewedApply) return yield* Effect.die(new Error("Missing guarded apply action"));
      const applied = yield* invoke(reviewedApply);
      if (applied.contract !== "setupApplied")
        return yield* Effect.die(new Error("Expected applied setup"));
      expect(yield* f.fs.exists(join(oldRoot, "review"))).toBe(false);
      const undoAction = applied.data.actions.find((action) => action.rel === "preview-undo");
      if (!undoAction) return yield* Effect.die(new Error("Missing undo action"));
      const undo = yield* invoke(undoAction.argv);
      if (undo.contract !== "setupUndo")
        return yield* Effect.die(new Error("Expected undo preview"));
      expect(undo.data.conflicts).toEqual([]);
      const undoApply = undo.data.actions.find((action) => action.rel === "apply-undo");
      if (!undoApply) return yield* Effect.die(new Error("Missing guarded undo action"));
      const restored = yield* invoke(undoApply.argv);
      expect(restored.contract === "setupUndo" && restored.data.status).toBe("undone");
      expect(yield* f.fs.exists(join(oldRoot, "review"))).toBe(true);
      expect(yield* f.fs.readLink(join(f.agents, "linked"))).toBe(linkedSource);
      expect(yield* f.fs.readLink(join(f.claude, "linked"))).toBe(linkedSource);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "changing selected paths or a duplicate choice cannot reuse a reviewed apply identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const discovery = yield* invoke(f.argv);
      if (discovery.contract !== "setup") return yield* Effect.die(new Error("Expected setup"));
      const selected = discovery.data.choices.find(
        (choice) => choice.kind === "copy" && choice.path === f.source,
      );
      if (!selected) return yield* Effect.die(new Error("Expected copy"));
      const review = yield* invoke(actionFor(selected.actions, "review").argv);
      if (review.contract !== "setupReview") return yield* Effect.die(new Error("Expected review"));
      const argv = [...actionFor(review.data.actions, "apply").argv];
      // Change the concrete selection while leaving both reviewed identities untouched.
      argv[argv.indexOf("--select-path")] = "--remove-path";
      const failed = yield* invoke(argv);
      if (failed.contract !== "setupFailed")
        return yield* Effect.die(new Error("Expected actionable failure"));
      expect(failed.data.message).toContain("reviewed setup choices changed");
      expect(yield* f.fs.exists(join(f.home, "state.json"))).toBe(false);
      expect(yield* f.fs.exists(f.source)).toBe(true);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("compares competing contents passively and exposes explicit version choices", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.makeDirectory(join(f.claude, "review"), { recursive: true });
    yield* f.fs.writeFileString(
      join(f.claude, "review", "SKILL.md"),
      "---\nname: review\ndescription: review fixture\n---\n\nDifferent Claude contents\n",
    );
    const discovery = yield* invoke(f.argv);
    if (discovery.contract !== "setup") return yield* Effect.die(new Error("Expected setup"));
    const selected = discovery.data.choices.find(
      (choice) => choice.kind === "copy" && choice.path === f.source,
    );
    if (!selected) return yield* Effect.die(new Error("Expected choice"));
    const compared = yield* invoke(actionFor(selected.actions, "compare").argv);
    if (compared.contract !== "setupComparison")
      return yield* Effect.die(new Error("Expected comparison"));
    expect(compared.data.copies).toHaveLength(2);
    expect(
      compared.data.copies.some((copy) => copy.markdown.includes("Original review bytes")),
    ).toBe(true);
    expect(
      compared.data.copies.some((copy) => copy.markdown.includes("Different Claude contents")),
    ).toBe(true);
    expect(compared.data.actions.filter((action) => action.rel === "review")).toHaveLength(2);
    expect(yield* f.fs.exists(f.home)).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an older work-dir approval cannot overwrite newer saved discovery settings", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const work = join(f.root, "chosen-work");
    yield* f.fs.makeDirectory(work);
    const before = yield* MachineSettings.updateDiscovery(f.home, {
      discoveryRoots: [join(f.root, "old-work")],
    });
    const discovery = yield* invoke([...f.argv, "--work-dir", work]);
    if (discovery.contract !== "setup") return yield* Effect.die(new Error("Expected setup"));
    const selected = discovery.data.choices.find(
      (choice) => choice.kind === "copy" && choice.path === f.source,
    );
    if (!selected) return yield* Effect.die(new Error("Expected copy choice"));
    const review = yield* invoke(actionFor(selected.actions, "review").argv);
    if (review.contract !== "setupReview") return yield* Effect.die(new Error("Expected review"));
    const newer = yield* MachineSettings.updateDiscovery(f.home, {
      discoveryRoots: [join(f.root, "newer-work")],
    });
    expect(newer.machineId).toBe(before.machineId);
    const failed = yield* invoke(actionFor(review.data.actions, "apply").argv);
    if (failed.contract !== "setupFailed")
      return yield* Effect.die(new Error("Expected a stale-settings failure"));
    expect(failed.exitCode).toBe(12);
    expect((yield* MachineSettings.read(f.home)).discoveryRoots).toEqual(newer.discoveryRoots);
    expect(yield* f.fs.exists(join(f.home, "state.json"))).toBe(false);
    expect(yield* f.fs.exists(join(f.claude, "review"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);
