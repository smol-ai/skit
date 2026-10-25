import { join } from "node:path";
import { Effect, Exit, FileSystem, Option } from "effect";
import { assert, it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { SetupPlanStale } from "../src/workflows/library/setup.js";
import type { SetupDuplicateAction } from "../src/workflows/library/setup-decisions.js";
import { SetupDuplicateDecisionRequired } from "../src/workflows/library/setup-review.js";
import { captureDisk, diskChanges, noDiskChanges } from "./helpers/disk-snapshot.js";
import { libraryHome, scratch } from "./helpers/library-home.js";

// `skit setup --apply <planId>`: an agent reviews the plan from `skit setup --json`, then applies
// exactly that recommendation without prompts. An empty prompt script makes any prompt a defect.

const skillBytes = (name: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n`;

const fixture = Effect.fn("Test.setupApplyReviewedPlan")(function* (input: { alias: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-setup-reviewed-");
  const claudeRoot = join(root, ".claude", "skills");
  const write = (path: string, name: string) =>
    Effect.andThen(
      fs.makeDirectory(path, { recursive: true }),
      fs.writeFileString(join(path, "SKILL.md"), skillBytes(name)),
    );
  yield* write(join(claudeRoot, "beta"), "beta");
  if (input.alias) {
    // Kept outside every root SKIT writes, and linked into Devin's own root. Devin also reads the
    // shared `.agents` root, so projecting alpha there gives Devin a second copy.
    const source = join(root, "Work", "skills", "alpha");
    const devinRoot = join(root, "config", "devin", "skills");
    yield* write(source, "alpha");
    yield* fs.makeDirectory(devinRoot, { recursive: true });
    yield* fs.symlink(source, join(devinRoot, "alpha"));
  } else yield* write(join(claudeRoot, "alpha"), "alpha");
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { "claude-code": [claudeRoot] },
  });
  const run = (
    flags: {
      apply?: { planId: string; duplicates?: SetupDuplicateAction };
      dryRun?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction([]);
      return yield* Effect.exit(
        home.owned(
          setupCommand({
            options: {
              libraryHome: home.home,
              inventory: home.inventory,
              probePath: "",
              skillsStateHome: join(root, "state"),
            },
            interactive: false,
            dryRun: flags.dryRun ?? false,
            ...(flags.apply ? { apply: flags.apply } : {}),
            localCustody: { bindings: home.bindings },
          }).pipe(Effect.provide(interaction.layer)),
        ),
      );
    });
  const review = Effect.gen(function* () {
    const exit = yield* run({ dryRun: true });
    assert.isTrue(Exit.isSuccess(exit));
    return Exit.isSuccess(exit) ? exit.value : yield* Effect.die("review failed");
  });
  return {
    home,
    run,
    review,
    disk: [
      home.home,
      join(root, ".claude"),
      join(root, ".agents"),
      join(root, "config"),
      join(root, "Work"),
    ],
  };
});

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

it.effect("applying the reviewed plan ID takes custody of every recommended copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ alias: false });
    const reviewed = yield* f.review;
    assert.deepStrictEqual(
      reviewed.onboarding.recommended.copies.map((copy) => copy.name),
      ["alpha", "beta"],
    );

    const exit = yield* f.run({ apply: { planId: reviewed.onboarding.planId } });

    assert.isTrue(Exit.isSuccess(exit));
    const state = yield* f.home.durable;
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
    assert.isNotEmpty(state.projections);
    assert.isTrue(state.projections.every((projection) => projection.status === "installed"));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a plan ID that no longer matches the machine applies nothing", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ alias: false });
    const before = yield* captureDisk(f.disk);

    const exit = yield* f.run({ apply: { planId: `sha256:${"0".repeat(64)}` } });

    assert.instanceOf(failure(exit), SetupPlanStale);
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a copy agents already see needs an explicit duplicates decision", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ alias: true });
    const reviewed = yield* f.review;
    const before = yield* captureDisk(f.disk);

    const refused = yield* f.run({ apply: { planId: reviewed.onboarding.planId } });

    const error = failure(refused);
    assert.instanceOf(error, SetupDuplicateDecisionRequired);
    assert.deepStrictEqual(error.names, ["alpha"]);
    assert.isTrue(error.retirable);
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);

    const applied = yield* f.run({
      apply: { planId: reviewed.onboarding.planId, duplicates: "retain-only" },
    });

    assert.isTrue(Exit.isSuccess(applied));
    const state = yield* f.home.durable;
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
