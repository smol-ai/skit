import { join } from "node:path";
import { Effect, Exit, FileSystem, Option } from "effect";
import { assert, it } from "@effect/vitest";
import { inspectOwnershipMarkerEffect, skitLayer } from "@smolai/skit-core";
import { setupApplyCommand, setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { SetupPlanStale } from "../src/workflows/library/setup.js";
import type { SetupDuplicateAction } from "../src/workflows/library/setup-decisions.js";
import { SetupDuplicateDecisionRequired } from "../src/workflows/library/setup-review.js";
import { captureDisk, diskChanges, noDiskChanges } from "./helpers/disk-snapshot.js";
import { libraryHome, scratch } from "./helpers/library-home.js";

// `skit setup --apply <planId>`: an agent reviews the plan from `skit setup --json`, then applies
// exactly that recommendation without prompts. An empty prompt script makes any prompt a defect.

const skillBytes = (name: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n`;

const fixture = Effect.fn("Test.setupApplyReviewedPlan")(function* (input: {
  alias: boolean;
  identical?: boolean;
}) {
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
  // The same bytes installed for Claude and in the shared root, as `npx skills add` leaves them.
  if (input.identical)
    for (const skills of [claudeRoot, join(root, ".agents", "skills")])
      yield* write(join(skills, "gamma"), "gamma");
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { "claude-code": [claudeRoot] },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const run = (apply: { planId: string; duplicates?: SetupDuplicateAction }) =>
    Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction([]);
      return yield* Effect.exit(
        home.owned(
          setupApplyCommand({
            options,
            localCustody: { bindings: home.bindings },
            ...apply,
          }).pipe(Effect.provide(interaction.layer)),
        ),
      );
    });
  const review = Effect.gen(function* () {
    const interaction = yield* makeScriptedInteraction([]);
    return yield* home.owned(
      setupCommand({ options, interactive: false, dryRun: true }).pipe(
        Effect.provide(interaction.layer),
      ),
    );
  });
  return {
    home,
    run,
    review,
    root,
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

    const exit = yield* f.run({ planId: reviewed.onboarding.planId });

    assert.isTrue(Exit.isSuccess(exit));
    const state = yield* f.home.durable;
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
    assert.isNotEmpty(state.projections);
    assert.isTrue(state.projections.every((projection) => projection.status === "installed"));
    // The result reports what happened, so a caller need not re-observe to find out.
    const report = Exit.isSuccess(exit) ? exit.value : undefined;
    assert.deepStrictEqual(
      report?.added.map((copy) => copy.name),
      ["alpha", "beta"],
    );
    assert.strictEqual(report?.projections.length, state.projections.length);
    assert.deepStrictEqual(report?.leftAlone, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a plan ID that no longer matches the machine applies nothing", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ alias: false });
    const before = yield* captureDisk(f.disk);

    const exit = yield* f.run({ planId: `sha256:${"0".repeat(64)}` });

    assert.instanceOf(failure(exit), SetupPlanStale);
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a copy agents already see needs an explicit duplicates decision", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ alias: true });
    const reviewed = yield* f.review;
    const before = yield* captureDisk(f.disk);

    const refused = yield* f.run({ planId: reviewed.onboarding.planId });

    const error = failure(refused);
    assert.instanceOf(error, SetupDuplicateDecisionRequired);
    assert.deepStrictEqual(error.names, ["alpha"]);
    assert.isTrue(error.retirable);
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);

    const applied = yield* f.run({ planId: reviewed.onboarding.planId, duplicates: "retain-only" });

    assert.isTrue(Exit.isSuccess(applied));
    const state = yield* f.home.durable;
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("identical copies at each target are adopted in place, not left to conflict", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ alias: false, identical: true });
    const reviewed = yield* f.review;

    const exit = yield* f.run({ planId: reviewed.onboarding.planId });

    assert.isTrue(Exit.isSuccess(exit));
    const state = yield* f.home.durable;
    const gamma = state.projections.filter((projection) => projection.path.endsWith("/gamma"));
    assert.deepStrictEqual(
      gamma.map((projection) => projection.status),
      ["installed", "installed"],
    );
    for (const skills of [join(f.root, ".claude", "skills"), join(f.root, ".agents", "skills")])
      assert.strictEqual(
        (yield* inspectOwnershipMarkerEffect(join(skills, "gamma"))).kind,
        "valid",
      );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
