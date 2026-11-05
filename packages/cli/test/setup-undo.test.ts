import { recoveryInspection } from "./helpers/recovery.js";
import { saveRecoveryFiles } from "./helpers/recovery-files.js";
import { withLibraryOwner } from "./helpers/library-owner.js";
import { dirname, join } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { systemError } from "effect/PlatformError";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Library } from "@smolai/skit-core/library";
import {
  hashParts,
  LinkStat,
  MachineSettings,
  prepareInstalledSkillRebuild,
  setupIntent,
  observePathEvidence,
  recoveryFingerprint,
} from "@smolai/skit-core";
import { skitLayer } from "@smolai/skit-core/platform";

const { setupDiscoverySettings } = MachineSettings;

import { prepareSetupUndo } from "../src/library/setup/undo.js";
import { setupResultActions } from "../src/library/setup/actions.js";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { renderContract } from "../src/commands/output-presenters.js";
import { prepareSetupCommand, setupApplyCommand } from "../src/library/setup/apply.js";
import { runSetup } from "@smolai/skit-core/library/setup";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
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
    roots: {
      codex: [join(root, "agents")],
      "claude-code": [join(root, "claude")],
    },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const scan = yield* home.owned(
    runSetup({ ...options, repositoryRoots: [root], persistRoots: false }),
  );
  const interaction = yield* makeScriptedInteraction([]);
  const input = {
    options,
    workDirFlag: root,
    ...(removeOnly ? { selection: { sourceIds: [], copyPaths: [], removePaths: [source] } } : {}),
    manageOptions: { installOptions: home.installOptions },
    planId: scan.onboarding.planId,
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
  return {
    fs,
    root,
    source,
    successor,
    markdown,
    home,
    applied,
    operationId: applied.operationId,
  };
});

it.effect(
  "the installed-skill byte owner reconstructs a former independent copy from retained artifacts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const state = yield* f.home.durable;
          const prior = state.installed_skills.find(
            (installedSkill) => installedSkill.path === f.successor,
          );
          if (prior === undefined) return yield* Effect.die("Missing installed successor");
          const rebuilt = yield* prepareInstalledSkillRebuild(state, f.home.originals, prior, {
            source: "declared",
          });
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

it.effect("undo of an explicit removal restores the original inode and move record state", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* f.home.owned(
      Effect.gen(function* () {
        const links = yield* LinkStat;
        const recovery = yield* recoveryInspection(f.home.home, f.operationId);
        expect(recovery.entries[0].status).toBe("saved");
        const identity = yield* links.identity.lstat(recovery.entries[0].recoveryPath);
        const preview = yield* prepareSetupUndo(f.operationId);
        expect(preview.summary.conflicts).toEqual([]);
        expect(preview.summary.files).toEqual([{ path: f.source, kind: "restore" }]);
        expect((yield* preview.apply()).status).toBe("undone");
        expect(yield* links.identity.lstat(f.source)).toEqual(identity);
        expect((yield* recoveryInspection(f.home.home, f.operationId)).entries[0].status).toBe(
          "at-original",
        );
        expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe(f.markdown);
      }),
    );
  }).pipe(Effect.provide(skitLayer)),
);

// Setups from before state.json recorded operations left a journal under removed/<id>/; undo reads
// it, in both formats it was written in. Here one is written as that SKIT wrote it for a removal.
it.effect.each([3, 2] as const)(
  "a setup journal from before records (v%s) still undoes",
  (version) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* scratch("skit-setup-journal-"));
      const source = join(root, "agents", "review");
      const markdown = "---\nname: review\ndescription: review\n---\n\nOriginal bytes\n";
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(join(source, "SKILL.md"), markdown);
      const home = yield* libraryHome({ home: join(root, "library"), inventoryHome: root });
      const operationId = "0f0e0d0c-0b0a-4908-8706-050403020100";
      const directory = join(home.home, "removed", operationId);
      const identity = (value: bigint) => (version === 3 ? String(value) : Number(value));
      const observed = Option.getOrThrow(yield* observePathEvidence(source));
      if (observed._tag !== "Directory")
        return yield* Effect.die("Expected legacy source directory");
      // Build the released journal format from public filesystem evidence, not its private reader.
      const file = {
        path: source,
        anchor: {
          path: dirname(source),
          physicalPath: observed.parent.path,
          dev: observed.parent.dev,
          ino: observed.parent.ino,
        },
        entry: {
          type: "Directory",
          dev: observed.dev,
          ino: observed.ino,
          hash: observed.contentHash,
          unstampedHash: yield* recoveryFingerprint(source, "exclude"),
          marker: null,
          markerType: null,
          markerMode: null,
          linkTarget: null,
        },
      };
      const moves = yield* saveRecoveryFiles(home.home, [source]);
      yield* fs.rename(moves.operationDirectory, directory);
      // This fixture represents the older UUID journal layout, including its receipt paths.
      for (const batch of yield* fs.readDirectory(directory)) {
        const receipt = join(directory, batch, "receipt.json");
        if (yield* fs.exists(receipt))
          yield* fs.writeFileString(
            receipt,
            (yield* fs.readFileString(receipt)).replaceAll(moves.operationDirectory, directory),
          );
      }
      const settings = setupDiscoverySettings(yield* MachineSettings.read(home.home));
      const intent = setupIntent(yield* home.durable);
      yield* fs.writeFileString(
        join(directory, "setup.json"),
        JSON.stringify({
          schemaVersion: version,
          kind: "setup",
          planId: hashParts(["journal"]),
          settings,
          machineId: null,
          targets: [],
          before: intent,
          installedSkills: [],
          installedSkillPaths: [],
          files: [
            {
              ...file,
              anchor: {
                ...file.anchor,
                dev: identity(file.anchor.dev),
                ino: identity(file.anchor.ino),
              },
              entry: file.entry && {
                ...file.entry,
                dev: identity(file.entry.dev),
                ino: identity(file.entry.ino),
              },
            },
          ],
        }),
      );
      yield* fs.writeFileString(
        join(directory, "complete.json"),
        JSON.stringify({ schemaVersion: 2, intent, settings, installedSkills: [] }),
      );
      // The v2 journal also covers a Library with no state.json: Undo records its first state.
      if (version === 2) yield* fs.remove(home.statePath);
      expect(yield* fs.exists(source)).toBe(false);
      yield* home.owned(
        Effect.gen(function* () {
          const preview = yield* prepareSetupUndo(operationId);
          expect(preview.summary.conflicts).toEqual([]);
          expect(preview.summary.files).toEqual([{ path: source, kind: "restore" }]);
          expect((yield* preview.apply()).status).toBe("undone");
        }),
      );
      expect(yield* fs.readFileString(join(source, "SKILL.md"))).toBe(markdown);
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
          const installed = yield* f.home.durable;
          yield* (yield* prepareSetupUndo(f.operationId)).apply();
          const undone = yield* f.home.durable;
          const later = { ...undone, enabled: installed.enabled };
          yield* f.home.writeDurable(later);
          const repeat = yield* prepareSetupUndo(f.operationId);
          expect(repeat.summary.status).toBe("already-undone");
          expect((yield* repeat.apply()).status).toBe("already-undone");
          expect(yield* f.home.durable).toEqual(later);
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

it.effect("an inverse record must save before any copy or intent changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.home.owned(
      Effect.gen(function* () {
        const state = yield* f.home.durable;
        const faultFs: typeof f.fs = {
          ...f.fs,
          rename: (from, to) =>
            to === f.home.statePath ? refusedPublication(to) : f.fs.rename(from, to),
        };
        const plan = yield* prepareSetupUndo(f.operationId);
        expect(
          (yield* Effect.flip(
            plan
              .apply()
              .pipe(withLibraryOwner, Effect.provideService(FileSystem.FileSystem, faultFs)),
          ))._tag,
        ).toBe("PlatformError");
        expect(yield* f.home.durable).toEqual(state);
        expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
        expect(yield* f.fs.exists(f.successor)).toBe(true);
      }),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a symlink replacing setup's marker never grants ownership of its target", () =>
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

it.effect("a cold owner finishes a recorded inverse interrupted before Library publication", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.home.owned(
      Effect.gen(function* () {
        const before = yield* f.home.durable;
        const reviewed = yield* prepareSetupUndo(f.operationId);
        let interrupted = false;
        const exit = yield* Effect.exit(
          reviewed.apply().pipe(
            withLibraryOwner,
            Effect.provideService(FileSystem.FileSystem, {
              ...f.fs,
              rename: (from, to) =>
                Effect.gen(function* () {
                  if (to === f.home.statePath) {
                    const next = JSON.parse(yield* f.fs.readFileString(from));
                    if (next.enabled.length === 0) {
                      interrupted = true;
                      return yield* Effect.die("Process exited before Undo publication");
                    }
                  }
                  yield* f.fs.rename(from, to);
                }),
            }),
          ),
        );
        expect(exit._tag).toBe("Failure");
        expect(interrupted).toBe(true);
        const pending = JSON.parse(yield* f.fs.readFileString(f.home.statePath));
        expect(pending.enabled).toEqual(before.enabled);
        expect(pending.operations.at(-1)._tag).toBe("Pending");
        expect(yield* f.fs.exists(f.successor)).toBe(false);
        expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
      }),
    );
    yield* f.home.owned(
      Effect.gen(function* () {
        const owner = yield* Library.Service;
        expect(owner.startup.finished.length).toBe(1);
        const repeated = yield* prepareSetupUndo(f.operationId);
        expect(repeated.summary.intentChanged).toBe(false);
        expect((yield* repeated.apply()).status).toBe("undone");
        expect((yield* f.home.durable).enabled).toEqual([]);
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
          expect((yield* f.home.durable).enabled).toEqual([]);
          // Library completed independently. Retrying settings must preserve new file edits and
          // later repository choices, without creating another Library inverse attempt.
          const recorded = (yield* f.home.durable).operations;
          expect(
            recorded.some(
              (operation) =>
                operation._tag === "Done" &&
                operation.steps.some(({ step }) => step._tag === "Undo"),
            ),
          ).toBe(true);
          yield* f.fs.writeFileString(
            join(f.source, "SKILL.md"),
            "Independent edit after Library undo",
          );
          yield* MachineSettings.setRepositoryDecision(f.home.home, "/later/repo", "watched");
          const refreshed = yield* prepareSetupUndo(f.operationId);
          expect(refreshed.summary.intentChanged).toBe(false);
          expect(refreshed.summary.settingsChanged).toBe(true);
          expect((yield* refreshed.apply()).status).toBe("undone");
          expect((yield* f.home.durable).operations).toEqual(recorded);
          expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe(
            "Independent edit after Library undo",
          );
          expect((yield* MachineSettings.read(f.home.home)).repositories).toEqual([
            { path: "/later/repo", status: "watched" },
          ]);
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
  "full undo releases managed ownership, preserves new installed copies, restores intent and discovery, and keeps retained artifacts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const before = yield* f.home.durable;
          expect(before.enabled.length).toBeGreaterThan(0);
          expect(yield* f.fs.exists(join(f.successor, ".skit-ownership.json"))).toBe(true);
          const plan = yield* prepareSetupUndo(f.operationId);
          expect(plan.summary.conflicts).toEqual([]);
          expect(plan.summary.files.map((file) => file.kind).sort()).toEqual([
            "release-ownership",
            "remove-created",
          ]);
          expect(yield* f.fs.exists(join(f.home.home, "removed", f.operationId, "undo"))).toBe(
            false,
          );
          const undone = yield* plan.apply();
          expect(undone.status).toBe("undone");
          const state = yield* f.home.durable;
          expect(state.enabled).toEqual([]);
          expect(state.installed_skills).toEqual([]);
          expect(state.skills).toEqual(before.skills);
          expect(state.collection_versions).toEqual(before.collection_versions);
          expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe(f.markdown);
          expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
          expect(yield* f.fs.exists(f.successor)).toBe(false);
          const settings = yield* MachineSettings.read(f.home.home);
          expect(settings.discoveryRoots).toEqual([]);
          expect(settings.repositories).toEqual([]);
          expect(settings.repositoryDecisionsInitialized).toBe(false);
          expect(settings.machineId).toBeDefined();
          if (!("backupId" in undone))
            return yield* Effect.die(new Error("Missing preservation identity"));
          const recovery = yield* recoveryInspection(f.home.home, undone.backupId);
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
          expect((yield* Effect.flip(plan.apply()))._tag).toBe("Library.StalePlan");
          expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
          const reviewed = yield* prepareSetupUndo(f.operationId);
          expect(reviewed.summary.conflicts).toEqual([]);
          const undone = yield* reviewed.apply();
          if (!("backupId" in undone))
            return yield* Effect.die(new Error("Missing preservation identity"));
          const recovery = yield* recoveryInspection(f.home.home, undone.backupId);
          expect(
            yield* f.fs.readFileString(join(recovery.entries[0].recoveryPath, "notes.txt")),
          ).toBe("Later user edits");
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a changed managed original blocks the entire inverse and keeps bindings and settings",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.home.owned(
        Effect.gen(function* () {
          const before = yield* f.home.durable;
          yield* f.fs.writeFileString(join(f.source, "SKILL.md"), "Edited original");
          const plan = yield* prepareSetupUndo(f.operationId);
          expect(plan.summary.status).toBe("conflicted");
          expect((yield* Effect.flip(plan.apply()))._tag).toBe("RecoveryInvalid");
          expect(yield* f.home.durable).toEqual(before);
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

it.effect(
  "a pre-split completed inverse keeps later settings even without a machine completion record",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const settingsBefore = yield* MachineSettings.read(f.home.home);
      const prepared = yield* f.home.owned(prepareSetupUndo(f.operationId));
      yield* f.home.owned(prepared.apply());
      const settingsAfter = yield* MachineSettings.read(f.home.home);
      const undoDirectory = join(f.home.home, "removed", f.operationId, "undo");
      const state = yield* f.home.durable;
      const operation = state.operations.find((item) =>
        item.steps.some(({ step }) => step._tag === "Undo"),
      );
      if (!operation) return yield* Effect.die("Missing recorded inverse");
      // Construct the immutable pre-split evidence explicitly; new Undo writes no attempt files.
      const attemptName = "10000000-0000-4000-8000-000000000001";
      yield* f.fs.makeDirectory(undoDirectory, { recursive: true });
      yield* f.fs.writeFileString(
        join(undoDirectory, `${attemptName}.json`),
        JSON.stringify({
          schemaVersion: 2,
          planId: prepared.summary.planId,
          backupId: "10000000-0000-4000-8000-000000000002",
          before: setupIntent(state),
          after: setupIntent(state),
          settingsBefore: setupDiscoverySettings(settingsBefore),
          settingsAfter: setupDiscoverySettings(settingsAfter),
        }),
      );
      yield* f.fs.writeFileString(
        join(undoDirectory, `${attemptName}.done.json`),
        JSON.stringify({ schemaVersion: 1, planId: prepared.summary.planId }),
      );
      yield* f.home.writeDurable({
        ...state,
        operations: state.operations.filter((item) => item.operationId !== operation.operationId),
      });
      const path = join(f.home.home, "machine.json");
      const { undoneSetups: _completed, ...machine } = JSON.parse(yield* f.fs.readFileString(path));
      const later = JSON.stringify({
        ...machine,
        schemaVersion: 6,
        discoveryRoots: settingsBefore.discoveryRoots,
      });
      yield* f.fs.writeFileString(path, later);
      const repeated = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(repeated.summary.status).toBe("already-undone");
      expect(repeated.summary.settingsChanged).toBe(false);
      expect((yield* f.home.owned(repeated.apply())).status).toBe("already-undone");
      expect(yield* f.fs.readFileString(path)).toBe(later);
    }).pipe(Effect.provide(skitLayer)),
);
