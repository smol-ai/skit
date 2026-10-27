import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  LibraryStore,
  LinkStat,
  MachineSettings,
  prepareInstalledSkillRebuildEffect,
  skitLayer,
} from "@smolai/skit-core";
import { checkSetupGlobalContent } from "../src/library-application/setup-content-custody.js";
import { recoveryFingerprint } from "../src/library-application/recovery-evidence.js";
import { prepareSetupUndo } from "../src/library-application/setup-undo.js";
import { setupResultActions } from "../src/commands/setup-actions.js";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { inspectRecoveryOperation } from "../src/library-application/recovery-moves.js";
import { prepareSetupCommand, setupApplyCommand } from "../src/handlers/library/setup-machine.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { libraryHome, scratch } from "./helpers/library-home.js";

const fixture = Effect.fn("Test.setupUndoFixture")(function* (removeOnly = false) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-setup-undo-"));
  const source = join(root, "agents", "review");
  const successor = join(root, "claude", "review");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(join(root, "claude"));
  const markdown = "---\nname: review\ndescription: review\n---\n\nOriginal bytes\n";
  yield* fs.writeFileString(join(source, "SKILL.md"), markdown);
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: [join(root, "agents")], "claude-code": [join(root, "claude")] },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const observed = yield* home.owned(
    runSetup({ ...options, repositoryRoots: [root], persistRoots: false }),
  );
  const interaction = yield* makeScriptedInteraction([]);
  const input = {
    options,
    workDirFlag: root,
    ...(removeOnly ? { selection: { sourceIds: [], copyPaths: [], removePaths: [source] } } : {}),
    localCustody: { bindings: home.bindings },
    planId: observed.onboarding.planId,
  };
  const applied = yield* home.owned(
    Effect.gen(function* () {
      const reviewed = removeOnly ? (yield* prepareSetupCommand(input)).plan.reviewId : undefined;
      return yield* setupApplyCommand({
        ...input,
        ...(reviewed ? { reviewedPlanId: reviewed } : {}),
      });
    }).pipe(Effect.provide(interaction.layer)),
  );
  if (!applied.operationId) return yield* Effect.die(new Error("Setup omitted operation ID"));
  return { fs, root, source, successor, markdown, home, applied, operationId: applied.operationId };
});

it.effect(
  "the projection byte owner reconstructs a former independent copy from retained artifacts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          const state = yield* store.load;
          const prior = state.projections.find((projection) => projection.path === f.successor)!;
          const rebuilt = yield* prepareInstalledSkillRebuildEffect(
            state,
            store.originalsPath,
            prior,
            {
              source: "declared",
            },
          );
          const stage = join(f.root, "reconstructed");
          yield* rebuilt.build(stage);
          expect(yield* recoveryFingerprint(stage, "exclude")).toBe(
            yield* recoveryFingerprint(f.successor, "exclude"),
          );
          expect(yield* f.fs.exists(join(stage, ".skit-ownership.json"))).toBe(false);
          yield* f.fs.writeFileString(join(stage, "SKILL.md"), "Independent writable copy");
          expect(yield* f.fs.readFileString(join(f.successor, "SKILL.md"))).toBe(f.markdown);
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "undo of an explicit removal restores the original inode and recovery receipt state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* f.home.owned(
        Effect.gen(function* () {
          const links = yield* LinkStat;
          const receipt = yield* inspectRecoveryOperation(f.home.home, f.operationId);
          expect(receipt.entries[0].status).toBe("saved");
          const identity = yield* links.identity.lstat(receipt.entries[0].recoveryPath);
          const preview = yield* prepareSetupUndo(f.operationId);
          expect(preview.summary.conflicts).toEqual([]);
          expect(preview.summary.files).toEqual([{ path: f.source, kind: "restore" }]);
          expect((yield* preview.apply()).status).toBe("undone");
          expect(yield* links.identity.lstat(f.source)).toEqual(identity);
          expect(
            (yield* inspectRecoveryOperation(f.home.home, f.operationId)).entries[0].status,
          ).toBe("at-original");
          expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe(f.markdown);
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("undo refuses an occupied removal destination and redirected original parent", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* f.home.owned(
      Effect.gen(function* () {
        yield* f.fs.makeDirectory(f.source);
        yield* f.fs.writeFileString(join(f.source, "notes.txt"), "New owner");
        const occupied = yield* prepareSetupUndo(f.operationId);
        expect(occupied.summary.status).toBe("conflicted");
        expect((yield* Effect.flip(occupied.apply()))._tag).toBe("RecoveryInvalid");
        yield* f.fs.rename(join(f.root, "agents"), join(f.root, "original-parent"));
        const replacement = join(f.root, "replacement-parent");
        yield* f.fs.makeDirectory(replacement);
        yield* f.fs.symlink(replacement, join(f.root, "agents"));
        const redirected = yield* prepareSetupUndo(f.operationId);
        expect(redirected.summary.conflicts).toContain(`Original parent changed: ${f.source}`);
        expect(yield* f.fs.readDirectory(replacement)).toEqual([]);
        expect(
          yield* f.fs.readFileString(join(f.root, "original-parent", "review", "notes.txt")),
        ).toBe("New owner");
      }),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a completed undo never reverses later choices even if they equal setup's former choices",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          const installed = yield* store.load;
          yield* (yield* prepareSetupUndo(f.operationId)).apply();
          const undone = yield* store.load;
          const later = { ...undone, global_bindings: installed.global_bindings };
          yield* store.save(later, undone);
          const repeat = yield* prepareSetupUndo(f.operationId);
          expect(repeat.summary.status).toBe("already-undone");
          expect((yield* repeat.apply()).status).toBe("already-undone");
          expect(yield* store.load).toEqual(later);
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

const refusedPublication = (path: string) =>
  Effect.fail(
    systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: path,
    }),
  );

it.effect("an inverse receipt must save before any copy or intent changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.home.owned(
      Effect.gen(function* () {
        const store = yield* LibraryStore;
        const state = yield* store.load;
        const faultFs: typeof f.fs = {
          ...f.fs,
          link: (from, to) =>
            to.includes("/undo/") && to.endsWith(".json")
              ? refusedPublication(to)
              : f.fs.link(from, to),
        };
        const plan = yield* prepareSetupUndo(f.operationId);
        expect(
          (yield* Effect.flip(
            plan.apply().pipe(Effect.provideService(FileSystem.FileSystem, faultFs)),
          ))._tag,
        ).toBe("PlatformError");
        expect(yield* store.load).toEqual(state);
        expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
        expect(yield* f.fs.exists(f.successor)).toBe(true);
      }),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a symlink replacing setup's marker never grants custody of its target", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.home.owned(
      Effect.gen(function* () {
        const target = join(f.root, "marker-target");
        yield* f.fs.writeFileString(target, "Independent bytes");
        const marker = join(f.successor, ".skit-ownership.json");
        yield* f.fs.remove(marker);
        yield* f.fs.symlink(target, marker);
        const preview = yield* prepareSetupUndo(f.operationId);
        expect(preview.summary.status).toBe("conflicted");
        expect((yield* Effect.flip(preview.apply()))._tag).toBe("RecoveryInvalid");
        expect(yield* f.fs.readFileString(target)).toBe("Independent bytes");
        expect(yield* f.fs.readLink(marker)).toBe(target);
      }),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "an interrupted inverse after file effects is inspectable and can finish only after a fresh review",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          const before = yield* store.load;
          const interrupted = yield* prepareSetupUndo(f.operationId).pipe(
            Effect.provideService(LibraryStore, {
              ...store,
              save: () => refusedPublication(store.statePath),
            }),
          );
          const failure = yield* Effect.flip(interrupted.apply());
          expect(failure._tag).toBe("PlatformError");
          expect(yield* store.load).toEqual(before);
          expect(yield* f.fs.exists(f.successor)).toBe(false);
          expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
          expect((yield* Effect.flip(interrupted.apply()))._tag).toBe("PlanIsStale");
          const refreshed = yield* prepareSetupUndo(f.operationId);
          expect(refreshed.summary.conflicts).toEqual([]);
          expect((yield* refreshed.apply()).status).toBe("undone");
          expect((yield* store.load).global_bindings).toEqual([]);
          expect((yield* MachineSettings.read(f.home.home)).discoveryRoots).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "failed settings restoration leaves a fresh inverse that completes after Library publication",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const plan = yield* prepareSetupUndo(f.operationId);
          const failure = yield* Effect.flip(
            plan.apply().pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...f.fs,
                rename: (from, to) =>
                  to === join(f.home.home, "machine.json")
                    ? refusedPublication(to)
                    : f.fs.rename(from, to),
              }),
            ),
          );
          expect(failure._tag).toBe("PlatformError");
          expect((yield* (yield* LibraryStore).load).global_bindings).toEqual([]);
          const refreshed = yield* prepareSetupUndo(f.operationId);
          expect(refreshed.summary.intentChanged).toBe(false);
          expect(refreshed.summary.settingsChanged).toBe(true);
          expect((yield* refreshed.apply()).status).toBe("undone");
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a generic client walks setup's undo actions through the parser and rendered result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const invoke = Effect.fn("Test.invokeSetupUndo")(function* (argv: readonly string[]) {
        const interaction = yield* makeScriptedInteraction([]);
        yield* runCommandTree(skitCommand, argv.slice(1), "test").pipe(
          Effect.provide(interaction.layer),
        );
        expect(yield* interaction.failures).toEqual([]);
        const [response] = yield* interaction.results;
        if (response.contract !== "setupUndo")
          return yield* Effect.die(new Error("Expected setup undo response"));
        return response;
      });
      const initial = setupResultActions(
        { home: f.home.home, inventory: f.home.inventory },
        f.applied,
      ).find((action) => action.rel === "preview-undo");
      if (!initial) return yield* Effect.die(new Error("Missing setup undo continuation"));
      const preview = yield* invoke(initial.argv);
      expect(preview.data.phase).toBe("preview");
      const apply = preview.data.actions.find((action) => action.rel === "apply-undo");
      if (!apply) return yield* Effect.die(new Error("Missing guarded undo apply"));
      const applied = yield* invoke(apply.argv);
      expect(applied.data.status).toBe("undone");
      expect(renderContract(applied, { color: false, detail: "full" })).toContain(
        "Setup undo: undone",
      );
      expect(applied.data.actions.some((action) => action.rel === "inspect-preserved")).toBe(true);
      expect((yield* invoke(applied.data.actions[0].argv)).data.status).toBe("already-undone");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "full undo releases adopted custody, preserves new installed copies, restores intent and discovery, and keeps retained artifacts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          const before = yield* store.load;
          expect(before.global_bindings[0].entries.length).toBeGreaterThan(0);
          expect(yield* f.fs.exists(join(f.successor, ".skit-ownership.json"))).toBe(true);
          const plan = yield* prepareSetupUndo(f.operationId);
          expect(plan.summary.conflicts).toEqual([]);
          expect(plan.summary.files.map((file) => file.kind).sort()).toEqual([
            "release-custody",
            "remove-created",
          ]);
          expect(yield* f.fs.exists(join(f.home.home, "removed", f.operationId, "undo"))).toBe(
            false,
          );
          const undone = yield* plan.apply();
          expect(undone.status).toBe("undone");
          const state = yield* store.load;
          expect(state.global_bindings).toEqual([]);
          expect(state.projections).toEqual([]);
          expect(state.skills).toEqual(before.skills);
          expect(state.retained_copies).toEqual(before.retained_copies);
          expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe(f.markdown);
          expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
          expect(yield* f.fs.exists(f.successor)).toBe(false);
          const settings = yield* MachineSettings.read(f.home.home);
          expect(settings.discoveryRoots).toEqual([]);
          expect(settings.repositories).toEqual([]);
          expect(settings.repositoryDecisionsInitialized).toBe(false);
          expect(settings.machineId).toBeDefined();
          if (!("preservationId" in undone))
            return yield* Effect.die(new Error("Missing preservation identity"));
          const recovery = yield* inspectRecoveryOperation(f.home.home, undone.preservationId);
          expect(recovery.entries).toHaveLength(1);
          expect(recovery.entries[0].status).toBe("saved");
          expect((yield* prepareSetupUndo(f.operationId)).summary.status).toBe("already-undone");
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "undo refuses stale reviewed evidence and retains edited successor bytes when reviewed afresh",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const plan = yield* prepareSetupUndo(f.operationId);
          yield* f.fs.writeFileString(join(f.successor, "notes.txt"), "Later user edits");
          expect((yield* Effect.flip(plan.apply()))._tag).toBe("PlanIsStale");
          expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
          const reviewed = yield* prepareSetupUndo(f.operationId);
          expect(reviewed.summary.conflicts).toEqual([]);
          const undone = yield* reviewed.apply();
          if (!("preservationId" in undone))
            return yield* Effect.die(new Error("Missing preservation identity"));
          const recovery = yield* inspectRecoveryOperation(f.home.home, undone.preservationId);
          expect(
            yield* f.fs.readFileString(join(recovery.entries[0].recoveryPath, "notes.txt")),
          ).toBe("Later user edits");
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a changed adopted original blocks the entire inverse and keeps bindings and settings",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          const before = yield* store.load;
          yield* f.fs.writeFileString(join(f.source, "SKILL.md"), "Edited original");
          const plan = yield* prepareSetupUndo(f.operationId);
          expect(plan.summary.status).toBe("conflicted");
          expect((yield* Effect.flip(plan.apply()))._tag).toBe("RecoveryInvalid");
          expect(yield* store.load).toEqual(before);
          expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("Edited original");
          expect(yield* f.fs.exists(f.successor)).toBe(true);
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect.each([".git", "skit.json", "skit.remote.json"])(
  "undo preserves newer external ownership established by %s in an ancestor",
  (marker) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* f.home.durable;
      const settings = yield* MachineSettings.read(f.home.home);
      const bytes = yield* f.fs.readFileString(join(f.successor, "SKILL.md"));
      yield* f.fs.writeFileString(
        join(f.root, "claude", marker),
        marker === ".git" ? "gitdir: newer-checkout" : "{}",
      );
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.status).toBe("conflicted");
      expect(
        inverse.summary.conflicts.some((conflict) => conflict.includes("ownership protects")),
      ).toBe(true);
      expect((yield* Effect.result(f.home.owned(inverse.apply())))._tag).toBe("Failure");
      expect(yield* f.home.durable).toEqual(before);
      expect(yield* MachineSettings.read(f.home.home)).toEqual(settings);
      expect(yield* f.fs.readFileString(join(f.successor, "SKILL.md"))).toBe(bytes);
      expect(yield* f.fs.exists(join(f.root, "claude", marker))).toBe(true);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("physical ancestors of a configured root alias retain their ownership veto", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* scratch("skit-protected-alias-"));
    const physical = join(root, "checkout", "nested", "skills");
    yield* fs.makeDirectory(physical, { recursive: true });
    const alias = join(root, "alias");
    yield* fs.symlink(physical, alias);
    const destination = join(alias, "absent-skill");
    yield* checkSetupGlobalContent(destination);
    yield* fs.writeFileString(join(root, "checkout", ".git"), "gitdir: elsewhere");
    expect((yield* Effect.result(checkSetupGlobalContent(destination)))._tag).toBe("Failure");
    expect(yield* fs.exists(destination)).toBe(false);
    expect(yield* fs.readLink(alias)).toBe(physical);
  }).pipe(Effect.provide(skitLayer)),
);
