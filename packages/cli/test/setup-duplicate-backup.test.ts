import { LinkStat } from "@smolai/skit-core/platform";
import { recoveryInspection } from "./helpers/recovery.js";
import { withLibraryOwner } from "./helpers/library-owner.js";
import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";

import type { LibraryFixtureState as LibraryState } from "./helpers/library-home.js";
import { skitLayer } from "@smolai/skit-core/platform";
import type { PlatformError } from "effect/PlatformError";
import { prepareSetupCommand, setupApplyCommand } from "../src/library/setup/apply.js";
import { runSetup } from "@smolai/skit-core/library/setup";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { prepareSetupUndo } from "../src/library/setup/undo.js";
import { libraryHome, scratch } from "./helpers/library-home.js";

const fixture = Effect.fn("Test.setupDuplicateCopies")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-duplicate-copies-"));
  const agents = join(root, "agents");
  const legacy = join(root, "legacy");
  const source = join(agents, "review");
  const duplicate = join(legacy, "review");
  const markdown = "---\nname: review\ndescription: Review code\n---\n\nOriginal contents\n";
  for (const path of [source, duplicate]) {
    yield* fs.makeDirectory(path, { recursive: true });
    yield* fs.writeFileString(join(path, "SKILL.md"), markdown);
  }
  yield* fs.writeFileString(join(duplicate, ".DS_Store"), "Excluded but irreplaceable");
  yield* fs.makeDirectory(join(duplicate, "empty"));
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: [agents], devin: [legacy, agents] },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const scan = yield* home.owned(runSetup({ ...options, persistRoots: false }));
  const input = {
    options,
    manageOptions: { installOptions: home.installOptions },
    planId: scan.onboarding.planId,
    selection: { sourceIds: [], copyPaths: [source], removePaths: [] },
  };
  const interaction = yield* makeScriptedInteraction([]);
  const prepared = yield* home.owned(
    prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
  );
  const apply = setupApplyCommand({ ...input, reviewedPlanId: prepared.plan.reviewId }).pipe(
    Effect.provide(interaction.layer),
  );
  return { fs, root, home, source, duplicate, markdown, prepared, apply, input, interaction };
});

/**
 * The real filesystem, except each replacement of `state.json` then runs `onSaved` with the state
 * it saved. Provided outside the owner, so the owner's saves go through it.
 */
const afterSaves =
  (statePath: string, onSaved: (next: LibraryState) => Effect.Effect<void, PlatformError>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* effect.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            to === statePath
              ? Effect.gen(function* () {
                  const next: LibraryState = JSON.parse(yield* fs.readFileString(from));
                  yield* fs.rename(from, to);
                  yield* onSaved(next);
                })
              : fs.rename(from, to),
        }),
      );
    });

it.effect("a protected authored copy has an explicit choice and no automatic preservation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(
      join(f.duplicate, "skit.remote.json"),
      "Uncertain authored metadata",
    );
    const scan = yield* f.home.owned(runSetup({ ...f.input.options, persistRoots: false }));
    const input = { ...f.input, planId: scan.onboarding.planId };
    const unresolved = yield* Effect.flip(
      f.home.owned(prepareSetupCommand(input).pipe(Effect.provide(f.interaction.layer))),
    );
    expect(unresolved._tag).toBe("SetupDuplicateDecisionRequired");
    const imported = yield* f.home.owned(
      prepareSetupCommand({ ...input, duplicates: "retain-only" }).pipe(
        Effect.provide(f.interaction.layer),
      ),
    );
    expect(imported.plan.summary.preserves).toEqual([]);
    expect(imported.plan.summary.enables).toEqual([]);
    expect(yield* f.fs.exists(f.duplicate)).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a directory that becomes repository-owned before cleanup stays in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const failed = yield* Effect.flip(
      f.home.owned(
        f.apply.pipe(
          withLibraryOwner(f.home.inventory),
          afterSaves(f.home.statePath, (next) =>
            next.installed_skills.some((installedSkill) => installedSkill.status === "installed")
              ? f.fs.writeFileString(join(f.duplicate, ".git"), "gitdir: newly-owned-checkout\n")
              : Effect.void,
          ),
        ),
      ),
    );
    // The copy no longer matches what the step recorded, so setup stops before moving it.
    expect(failed._tag).toBe("SetupStopped");
    expect(yield* f.fs.readFileString(join(f.duplicate, "SKILL.md"))).toBe(f.markdown);
    expect(yield* f.fs.readFileString(join(f.duplicate, ".git"))).toBe(
      "gitdir: newly-owned-checkout\n",
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "selected equal global copies are preserved after their replacement is installed and full undo restores them exactly",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const links = yield* LinkStat;
      const original = yield* links.identity.lstat(f.duplicate);
      expect(f.prepared.plan.summary.preserves).toEqual([
        { name: "review", path: f.duplicate, kind: "directory" },
      ]);
      expect(yield* f.fs.exists(f.duplicate)).toBe(true);
      const applied = yield* f.home.owned(f.apply);
      expect(yield* f.fs.exists(f.duplicate)).toBe(false);
      expect(
        (yield* f.home.durable).installed_skills.every(
          (installedSkill) => installedSkill.status === "installed",
        ),
      ).toBe(true);
      if (!applied.operationId) return yield* Effect.die(new Error("Missing operation ID"));
      const recovery = yield* recoveryInspection(f.home.home, applied.operationId);
      expect(recovery.entries).toHaveLength(1);
      expect(recovery.entries[0].status).toBe("saved");
      expect(yield* f.fs.readFileString(join(recovery.entries[0].recoveryPath, ".DS_Store"))).toBe(
        "Excluded but irreplaceable",
      );
      const inverse = yield* f.home.owned(prepareSetupUndo(applied.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      yield* f.home.owned(inverse.apply());
      expect(yield* links.identity.lstat(f.duplicate)).toEqual(original);
      expect(yield* f.fs.readFileString(join(f.duplicate, ".DS_Store"))).toBe(
        "Excluded but irreplaceable",
      );
      expect(yield* f.fs.readDirectory(join(f.duplicate, "empty"))).toEqual([]);
      expect((yield* f.home.durable).enabled).toEqual([]);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("a duplicate changed after selection invalidates the approval without moving it", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(join(f.duplicate, "SKILL.md"), "Newer independent contents");
    expect((yield* Effect.flip(f.home.owned(f.apply)))._tag).toBe("SetupPlanStale");
    expect(yield* f.fs.readFileString(join(f.duplicate, "SKILL.md"))).toBe(
      "Newer independent contents",
    );
    expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
    expect((yield* f.home.snapshot)._tag).toBe("Absent");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect.each(["installing", "cleanup"] as const)(
  "an installed replacement edited during %s preserves both copies and reports why",
  (boundary) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let edited = false;
      const outcome = yield* f.home
        .owned(
          f.apply.pipe(
            withLibraryOwner(f.home.inventory),
            afterSaves(f.home.statePath, (next) => {
              const operation = next.operations.find((operation) => operation._tag === "Pending");
              const apply =
                operation?._tag === "Pending"
                  ? operation.steps.find((step) => step.step._tag === "Manage")?.applies?.at(-1)
                      ?.apply
                  : undefined;
              const atBoundary =
                apply !== undefined &&
                (boundary === "cleanup"
                  ? apply.phase._tag === "Done"
                  : apply.phase._tag !== "Done" &&
                    next.installed_skills.some((copy) => copy.status === "installed"));
              return !edited && atBoundary
                ? f.fs.writeFileString(join(f.source, "SKILL.md"), "New user edits").pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        edited = true;
                      }),
                    ),
                  )
                : Effect.void;
            }),
          ),
        )
        .pipe(Effect.result);
      expect(edited).toBe(true);
      expect(yield* f.fs.exists(f.duplicate)).toBe(true);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("New user edits");
      expect(yield* f.fs.exists(join(f.home.home, "removed"))).toBe(false);
      if (boundary === "installing") {
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag !== "Failure") return;
        expect(outcome.failure._tag).toBe("SetupStopped");
        expect((yield* f.home.durable).operations.map((operation) => operation._tag)).toEqual([
          "Stopped",
        ]);
        return;
      }
      expect(outcome._tag).toBe("Success");
      if (outcome._tag !== "Success") return;
      const applied = outcome.success;
      expect(
        applied.backupWarnings?.some((warning) => warning.reason._tag === "ReplacementChanged"),
      ).toBe(true);
      expect(applied.recoveryDirectories).toEqual([]);
    }).pipe(Effect.provide(skitLayer)),
);
