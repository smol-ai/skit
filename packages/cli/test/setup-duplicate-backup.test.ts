import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { LibraryStore, LinkStat, skitLayer } from "@smolai/skit-core";
import { prepareSetupCommand, setupApplyCommand } from "../src/handlers/library/setup-machine.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { inspectRecoveryOperation } from "../src/library-application/recovery-moves.js";
import { prepareSetupUndo } from "../src/library-application/setup-undo.js";
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
  const observed = yield* home.owned(runSetup({ ...options, persistRoots: false }));
  const input = {
    options,
    manageOptions: { bindings: home.bindings },
    planId: observed.onboarding.planId,
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

it.effect("a protected authored copy has an explicit choice and no automatic preservation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(
      join(f.duplicate, "skit.remote.json"),
      "Uncertain authored metadata",
    );
    const observed = yield* f.home.owned(runSetup({ ...f.input.options, persistRoots: false }));
    const input = { ...f.input, planId: observed.onboarding.planId };
    const unresolved = yield* Effect.flip(
      f.home.owned(prepareSetupCommand(input).pipe(Effect.provide(f.interaction.layer))),
    );
    expect(unresolved._tag).toBe("SetupDuplicateDecisionRequired");
    const retained = yield* f.home.owned(
      prepareSetupCommand({ ...input, duplicates: "retain-only" }).pipe(
        Effect.provide(f.interaction.layer),
      ),
    );
    expect(retained.plan.summary.preserves).toEqual([]);
    expect(retained.plan.summary.enables).toEqual([]);
    expect(yield* f.fs.exists(f.duplicate)).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a directory that becomes repository-owned before cleanup stays in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const failed = yield* Effect.flip(
      f.home.owned(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          return yield* f.apply.pipe(
            Effect.provideService(LibraryStore, {
              ...store,
              save: (next, base) =>
                Effect.gen(function* () {
                  yield* store.save(next, base);
                  if (next.projections.some((projection) => projection.status === "installed"))
                    yield* f.fs.writeFileString(
                      join(f.duplicate, ".git"),
                      "gitdir: newly-owned-checkout\n",
                    );
                }),
            }),
          );
        }),
      ),
    );
    expect(failed._tag).toBe("PlanIsStale");
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
        (yield* f.home.durable).projections.every(
          (projection) => projection.status === "installed",
        ),
      ).toBe(true);
      if (!applied.operationId) return yield* Effect.die(new Error("Missing operation ID"));
      const recovery = yield* inspectRecoveryOperation(f.home.home, applied.operationId);
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
      expect((yield* f.home.durable).global_bindings).toEqual([]);
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
    expect((yield* f.home.durable).skills).toEqual([]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "an installed replacement edited before cleanup leaves the old copy active and reports why",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const applied = yield* f.home.owned(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          return yield* f.apply.pipe(
            Effect.provideService(LibraryStore, {
              ...store,
              save: (next, base) =>
                Effect.gen(function* () {
                  yield* store.save(next, base);
                  if (next.projections.some((projection) => projection.status === "installed"))
                    yield* f.fs.writeFileString(join(f.source, "SKILL.md"), "New user edits");
                }),
            }),
          );
        }),
      );
      expect(yield* f.fs.exists(f.duplicate)).toBe(true);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("New user edits");
      expect(
        applied.preservationWarnings?.some((warning) =>
          warning.message.includes("changed before preservation"),
        ),
      ).toBe(true);
      expect(applied.recoveryDirectories).toEqual([]);
    }).pipe(Effect.provide(skitLayer)),
);
