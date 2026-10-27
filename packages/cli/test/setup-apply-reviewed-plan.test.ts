import { join } from "node:path";
import { Effect, Exit, FileSystem, Option } from "effect";
import { assert, it } from "@effect/vitest";
import {
  inspectOwnershipMarkerEffect,
  MachineSettings,
  ProjectionRootNotWritable,
  skitLayer,
} from "@smolai/skit-core";
import { setupApplyCommand, setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { SetupPlanStale } from "../src/workflows/library/setup.js";
import { OptionCombinationInvalid } from "../src/workflows/failures.js";
import type { SetupDuplicateAction } from "../src/workflows/library/setup-decisions.js";
import { SetupDuplicateDecisionRequired } from "../src/workflows/library/setup-review.js";
import { captureDisk, diskChanges, noDiskChanges } from "./helpers/disk-snapshot.js";
import { libraryHome, scratch } from "./helpers/library-home.js";
import { withSandboxDenying } from "./helpers/sandbox.js";

// `skit setup --apply <planId>`: an agent reviews the plan from `skit setup --json`, then applies
// exactly that recommendation without prompts. An empty prompt script makes any prompt a defect.

const skillBytes = (name: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n`;

const fixture = Effect.fn("Test.setupApplyReviewedPlan")(function* (input: {
  alias: boolean;
  identical?: boolean;
  linked?: boolean;
  skillsSh?: boolean;
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
  // A skill kept in dotfiles and linked into Claude's root, where SKIT also writes its copy.
  if (input.linked) {
    yield* write(join(root, "dotfiles", "skills", "delta"), "delta");
    yield* fs.symlink(join(root, "dotfiles", "skills", "delta"), join(claudeRoot, "delta"));
  }
  // `npx skills add` keeps the skill in the shared root and links Claude's root to it.
  if (input.skillsSh) {
    yield* write(join(root, ".agents", "skills", "eps"), "eps");
    yield* fs.symlink(join(root, ".agents", "skills", "eps"), join(claudeRoot, "eps"));
  }
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
  const run = (apply: {
    planId: string;
    duplicates?: SetupDuplicateAction;
    workDirFlag?: string;
  }) =>
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
    options,
    run,
    review,
    root,
    disk: [
      home.home,
      join(root, ".claude"),
      join(root, ".agents"),
      join(root, "config"),
      join(root, "Work"),
      join(root, "dotfiles"),
    ],
  };
});

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

it.effect(
  "retain-only works without projection write access, while enabling still fails before retention",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture({ alias: true });
      // Leave only the duplicate copy whose approved action is retention without enabling.
      yield* fs.remove(join(f.root, ".claude", "skills", "beta"), { recursive: true });
      const reviewed = yield* f.review;
      const before = yield* captureDisk(f.disk);
      const denied = withSandboxDenying(join(f.root, ".agents"));

      const refused = yield* f
        .run({ planId: reviewed.onboarding.planId, duplicates: "retire-aliases" })
        .pipe(denied);
      assert.instanceOf(failure(refused), ProjectionRootNotWritable);
      assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);

      const retained = yield* f
        .run({ planId: reviewed.onboarding.planId, duplicates: "retain-only" })
        .pipe(denied);
      assert.isTrue(Exit.isSuccess(retained));
      const state = yield* f.home.durable;
      assert.deepStrictEqual(
        state.skills.map((skill) => skill.name),
        ["alpha"],
      );
      assert.deepStrictEqual(state.projections, []);
      assert.strictEqual(
        yield* fs.readLink(join(f.root, "config", "devin", "skills", "alpha")),
        join(f.root, "Work", "skills", "alpha"),
      );
      assert.isFalse(yield* fs.exists(join(f.root, ".agents")));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("applying with different discovery roots rejects the plan without saving them", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* fixture({ alias: false });
    const reviewedRoot = join(f.root, "first");
    const otherRoot = join(f.root, "second");
    yield* fs.makeDirectory(reviewedRoot);
    yield* fs.makeDirectory(otherRoot);
    const interaction = yield* makeScriptedInteraction([]);
    const reviewed = yield* f.home.owned(
      setupCommand({
        options: f.options,
        workDirFlag: reviewedRoot,
        interactive: false,
        dryRun: true,
      }).pipe(Effect.provide(interaction.layer)),
    );
    const before = yield* captureDisk(f.disk);

    const refused = yield* f.run({ planId: reviewed.onboarding.planId, workDirFlag: otherRoot });
    assert.instanceOf(failure(refused), SetupPlanStale);
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);

    const applied = yield* f.run({ planId: reviewed.onboarding.planId, workDirFlag: reviewedRoot });
    assert.isTrue(Exit.isSuccess(applied));
    assert.deepStrictEqual((yield* MachineSettings.read(f.home.home)).discoveryRoots, [
      reviewedRoot,
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "changed repository decisions invalidate a reviewed plan even without skill changes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ alias: false });
      const reviewed = yield* f.review;
      yield* MachineSettings.updateDiscovery(f.home.home, {
        repositories: [{ path: join(f.root, "repo"), status: "ignored" }],
      });
      const before = yield* captureDisk(f.disk);

      const refused = yield* f.run({ planId: reviewed.onboarding.planId });
      assert.instanceOf(failure(refused), SetupPlanStale);
      assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

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

it.effect("retiring aliases reports where the symlinks and their receipts were saved", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* fixture({ alias: true });
    const reviewed = yield* f.review;

    const applied = yield* f.run({
      planId: reviewed.onboarding.planId,
      duplicates: "retire-aliases",
    });

    assert.isTrue(Exit.isSuccess(applied));
    const directories = Exit.isSuccess(applied)
      ? (applied.value.aliasRecoveryDirectories ?? [])
      : [];
    assert.lengthOf(directories, 1);
    assert.isTrue(yield* fs.exists(directories[0]!));
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

// A link at SKIT's own destination is the user's choice about where the skill lives. Projecting
// would replace it, so it needs the same decision as any other copy an agent already sees.
it.effect("a skill linked into a destination is replaced only on an explicit retire-aliases", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const link = (f: { root: string }) => join(f.root, ".claude", "skills", "delta");
    const source = (f: { root: string }) => join(f.root, "dotfiles", "skills", "delta");

    const undecided = yield* fixture({ alias: false, linked: true });
    const before = yield* captureDisk(undecided.disk);
    const planId = (yield* undecided.review).onboarding.planId;
    const refused = failure(yield* undecided.run({ planId }));
    assert.instanceOf(refused, SetupDuplicateDecisionRequired);
    assert.deepStrictEqual(refused.names, ["delta"]);
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);

    const retained = yield* fixture({ alias: false, linked: true });
    const retainedPlan = (yield* retained.review).onboarding.planId;
    const kept = yield* retained.run({ planId: retainedPlan, duplicates: "retain-only" });
    assert.isTrue(Exit.isSuccess(kept));
    assert.strictEqual(yield* fs.readLink(link(retained)), source(retained));
    assert.include(
      (yield* retained.home.durable).skills.map((skill) => skill.name),
      "delta",
    );

    const retired = yield* fixture({ alias: false, linked: true });
    const retiredPlan = (yield* retired.review).onboarding.planId;
    const replaced = yield* retired.run({ planId: retiredPlan, duplicates: "retire-aliases" });
    assert.isTrue(Exit.isSuccess(replaced));
    assert.strictEqual((yield* inspectOwnershipMarkerEffect(link(retired))).kind, "valid");
    const backups = join(retired.root, ".claude", ".skit-backups");
    const saved = (yield* fs.readDirectory(backups)).filter((entry) => entry !== ".gitignore");
    assert.lengthOf(saved, 1);
    assert.strictEqual(yield* fs.readLink(join(backups, saved[0]!)), source(retired));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keep-both is refused for a linked skill before anything is written", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ alias: false, linked: true });
    const planId = (yield* f.review).onboarding.planId;
    const before = yield* captureDisk(f.disk);

    const refused = failure(yield* f.run({ planId, duplicates: "keep-both" }));

    assert.instanceOf(refused, OptionCombinationInvalid);
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a skills.sh link from Claude's root to the shared root needs a decision", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* fixture({ alias: false, skillsSh: true });
    const reviewed = yield* f.review;
    assert.deepStrictEqual(
      reviewed.onboarding.candidates.find((candidate) => candidate.name === "eps")
        ?.destinationLinks,
      [join(f.root, ".claude", "skills", "eps")],
    );

    const refused = failure(yield* f.run({ planId: reviewed.onboarding.planId }));
    assert.instanceOf(refused, SetupDuplicateDecisionRequired);
    assert.include(refused.names, "eps");

    const kept = yield* f.run({ planId: reviewed.onboarding.planId, duplicates: "retain-only" });
    assert.isTrue(Exit.isSuccess(kept));
    assert.strictEqual(
      yield* fs.readLink(join(f.root, ".claude", "skills", "eps")),
      join(f.root, ".agents", "skills", "eps"),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
