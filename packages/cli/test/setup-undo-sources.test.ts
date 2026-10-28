import { createHash } from "node:crypto";
import { join } from "node:path";
import { Clock, Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  enabledSkillIds,
  type LibraryState,
  currentSkillVersion,
  libraryManifestFromLocalState,
  LibraryStore,
  installEnabledSkills,
  MachineSettings,
  collectionVersionPath,
  sourceImports,
  skitLayer,
} from "@smolai/skit-core";
import { skillsDirectoryFor } from "../src/install/roots.js";
import { prepareSetupCommand, setupApplyCommand } from "../src/handlers/library/setup-machine.js";
import { prepareSetupUndo } from "../src/library-application/setup-undo.js";
import { inspectSetupOperation } from "../src/library-application/setup-operation.js";
import { listRecoveryOperations } from "../src/library-application/recovery-moves.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { mergeLibraryManifests } from "../src/workflows/library/library-merge.js";
import {
  deterministicTreeHash,
  libraryHome,
  importCollectionIn,
  scratch,
  writingTo,
} from "./helpers/library-home.js";

const document = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`;

const fixture = Effect.fn("Test.setupSourceUndo")(function* (
  selectedOverride = false,
  failSourceAcknowledgement = false,
  projectExisting = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-undo-source-"));
  const repository = join(root, "project");
  const existing = join(repository, ".agents", "skills", "existing");
  const introduced = join(repository, ".agents", "skills", "introduced");
  yield* fs.makeDirectory(existing, { recursive: true });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  expect(
    yield* spawner.exitCode(ChildProcess.make("git", ["init", "-q"], { cwd: repository })),
  ).toBe(0);
  const home = yield* libraryHome({ home: join(root, "library"), inventoryHome: root });
  const origin = { type: "well-known" as const, origin: "https://skills.example" };
  yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00.000Z"));
  yield* fs.writeFileString(join(existing, "SKILL.md"), document("existing", "Before setup"));
  const importSource = (paths: readonly { name: string; path: string }[]) =>
    Effect.gen(function* () {
      const skills = yield* Effect.forEach(paths, (item) =>
        Effect.gen(function* () {
          return {
            name: item.name,
            sourcePath: item.path,
            relativePath: item.name,
            currentHash: yield* deterministicTreeHash(item.path),
          };
        }),
      );
      return yield* writingTo(
        home.home,
        importCollectionIn(home.home)({
          input: origin.origin,
          source: origin,
          importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          skills,
          lockFileEntries: [],
        }),
      );
    });
  if (selectedOverride) {
    yield* fs.writeFileString(
      join(existing, "SKILL.md"),
      document("existing", "Earlier selected version"),
    );
    yield* importSource([{ name: "existing", path: existing }]);
    yield* TestClock.adjust("1 second");
    yield* fs.writeFileString(join(existing, "SKILL.md"), document("existing", "Before setup"));
  }
  yield* importSource([{ name: "existing", path: existing }]);
  const initial = yield* home.durable;
  const collectionId = initial.collections[0].collection_id;
  const enabled = [{ collection: collectionId }];
  let before: LibraryState = {
    ...initial,
    enabled,
    skills: selectedOverride
      ? initial.skills.map((skill) => ({
          ...skill,
          local_version_id: skill.versions[0].skill_version_id,
        }))
      : initial.skills,
  };
  yield* home.owned(Effect.flatMap(LibraryStore, (store) => store.save(before, initial)));
  if (projectExisting) {
    yield* home.owned(
      writingTo(
        home.home,
        installEnabledSkills({
          target: "agents",
          root: skillsDirectoryFor("agents", { kind: "global" }, home.inventory),
          variantsPath: home.variantsPath,
        }),
      ),
    );
    before = yield* home.durable;
  }
  yield* TestClock.adjust("1 day");
  yield* fs.makeDirectory(introduced);
  const texts = {
    existing: document("existing", "Setup source update"),
    introduced: document("introduced", "New source member"),
  };
  for (const [name, text] of Object.entries(texts))
    yield* fs.writeFileString(join(repository, ".agents", "skills", name, "SKILL.md"), text);
  yield* fs.writeFileString(
    join(repository, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: Object.fromEntries(
        Object.entries(texts).map(([name, text]) => [
          name,
          {
            source: "wellknown/skills.example",
            sourceType: "well-known",
            sourceUrl: origin.origin,
            computedHash: createHash("sha256").update("SKILL.md").update(text).digest("hex"),
          },
        ]),
      ),
    }),
  );
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const scan = yield* home.owned(
    runSetup({ ...options, repositoryRoots: [root], persistRoots: false }),
  );
  expect(scan.onboarding.recommended.sources).toHaveLength(1);
  const interaction = yield* makeScriptedInteraction([]);
  const executed = yield* Effect.result(
    home.owned(
      setupApplyCommand({
        options,
        workDirFlag: root,
        manageOptions: { installOptions: home.installOptions },
        planId: scan.onboarding.planId,
      }).pipe(
        Effect.provide(interaction.layer),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          link: (from, to) =>
            Effect.gen(function* () {
              if (failSourceAcknowledgement && to.endsWith(".published.json")) {
                const change = JSON.parse(
                  yield* fs.readFileString(to.replace(".published.json", ".json")),
                );
                if (change.kind === "library")
                  return yield* systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "link",
                    pathOrDescriptor: to,
                  });
              }
              return yield* fs.link(from, to);
            }),
        }),
      ),
    ),
  );
  let operationId: string | undefined;
  if (failSourceAcknowledgement) {
    expect(executed._tag).toBe("Failure");
    if (executed._tag === "Failure") expect(executed.failure._tag).toBe("PlatformError");
    [operationId] = yield* listRecoveryOperations(home.home);
  } else {
    if (executed._tag === "Failure") return yield* Effect.fail(executed.failure);
    operationId = executed.success.operationId;
  }
  if (!operationId) return yield* Effect.die(new Error("Setup omitted operation evidence"));
  yield* TestClock.adjust("1 second");
  return {
    fs,
    root,
    home,
    options,
    applied: executed._tag === "Success" ? executed.success : undefined,
    existing,
    introduced,
    before,
    enabled,
    importSource,
    operationId,
    collectionId,
  };
});

it.effect(
  "full undo resolves an interrupted forward source publication from actual Library revision",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, true);
      const operation = yield* inspectSetupOperation(f.home.home, f.operationId);
      expect(operation.complete).toBeUndefined();
      expect(operation.changes.at(-1)?.saved).toBe(false);
      expect(enabledSkillIds(yield* f.home.durable, f.enabled)).toHaveLength(2);
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      expect(inverse.summary.sourceSelections).toHaveLength(1);
      yield* f.home.owned(inverse.apply());
      expect(enabledSkillIds(yield* f.home.durable, f.enabled)).toHaveLength(1);
      expect((yield* f.home.durable).skills).toHaveLength(2);
      expect((yield* MachineSettings.read(f.home.home)).discoveryRoots).toEqual([]);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a generic client reviews the exact source snapshot and executes its returned undo action",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const invoke = Effect.fn("Test.sourceUndoCommand")(function* (argv: readonly string[]) {
        const interaction = yield* makeScriptedInteraction([]);
        yield* runCommandTree(skitCommand, argv.slice(1), "test").pipe(
          Effect.provide(interaction.layer),
        );
        expect(yield* interaction.failures).toEqual([]);
        const [response] = yield* interaction.results;
        if (response.contract !== "setupUndo")
          return yield* Effect.die(new Error("Expected source undo response"));
        return response;
      });
      const preview = yield* invoke([
        "skit",
        "library",
        "undo",
        f.operationId,
        "--home",
        f.home.home,
        "--json",
      ]);
      expect(preview.data.sourceSelections).toHaveLength(1);
      expect(renderContract(preview, { color: false, detail: "full" })).toContain(
        preview.data.sourceSelections[0].toSnapshot,
      );
      const action = preview.data.actions.find((item) => item.rel === "apply-undo");
      if (!action) return yield* Effect.die(new Error("Missing source undo action"));
      expect((yield* invoke(action.argv)).data.status).toBe("undone");
      expect(enabledSkillIds(yield* f.home.durable, f.enabled)).toHaveLength(1);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "source membership restoration also restores a pre-existing selected version override",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const after = yield* f.home.durable;
      expect(
        after.skills.find((skill) => skill.skill_id === f.before.skills[0].skill_id)
          ?.local_version_id,
      ).toBeUndefined();
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      yield* f.home.owned(inverse.apply());
      const restored = yield* f.home.durable;
      const skill = restored.skills.find((item) => item.skill_id === f.before.skills[0].skill_id)!;
      expect(skill.local_version_id).toBe(f.before.skills[0].local_version_id);
      expect(currentSkillVersion(restored, skill)?.skill_version_id).toBe(
        currentSkillVersion(f.before, f.before.skills[0])?.skill_version_id,
      );
      expect(enabledSkillIds(restored, f.enabled)).toHaveLength(1);
      expect(restored.collection_versions).toEqual(after.collection_versions);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "full undo restores followed source membership and versions without discarding any acquired bytes or freezing future refresh",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const after = yield* f.home.durable;
      expect(enabledSkillIds(after, f.enabled)).toHaveLength(2);
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      expect(inverse.summary.sourceSelections).toHaveLength(1);
      yield* f.home.owned(inverse.apply());
      const restored = yield* f.home.durable;
      expect(restored.enabled).toEqual(f.before.enabled);
      expect(enabledSkillIds(restored, f.enabled)).toEqual(enabledSkillIds(f.before, f.enabled));
      expect(restored.skills).toHaveLength(2);
      expect(restored.collection_versions).toEqual(after.collection_versions);
      expect(restored.imports).toHaveLength(after.imports.length + 1);
      for (const sourceImport of after.imports)
        expect(restored.imports).toContainEqual(sourceImport);
      const prior = f.before.skills[0];
      const selected = restored.skills.find((skill) => skill.skill_id === prior.skill_id)!;
      expect(currentSkillVersion(restored, selected)?.skill_version_id).toBe(
        currentSkillVersion(f.before, prior)?.skill_version_id,
      );
      expect(selected.local_version_id).toBeUndefined();
      const observation = sourceImports(restored, f.collectionId)[0];
      const original = sourceImports(f.before, f.collectionId)[0];
      expect(observation.collection_version_id).toBe(original.collection_version_id);
      expect(observation.lock_file_entries).toEqual([]);
      const copy = restored.collection_versions.find(
        (item) => item.collection_version_id === original.collection_version_id,
      )!;
      expect(observation.input.value).toBe(
        collectionVersionPath(join(f.home.home, "originals"), copy.digest),
      );
      const afterManifest = yield* libraryManifestFromLocalState(after);
      const restoredManifest = yield* libraryManifestFromLocalState(restored);
      expect(restoredManifest.imports).toEqual(restored.imports);
      const synced = mergeLibraryManifests(afterManifest, restoredManifest, afterManifest);
      expect(synced.conflicts).toEqual([]);
      expect(enabledSkillIds(synced.manifest, f.enabled)).toHaveLength(1);
      expect(synced.manifest.imports.map((item) => item.import_id).sort()).toEqual(
        restored.imports.map((item) => item.import_id).sort(),
      );
      expect((yield* MachineSettings.read(f.home.home)).discoveryRoots).toEqual([]);
      expect((yield* f.home.owned(prepareSetupUndo(f.operationId))).summary.status).toBe(
        "already-undone",
      );
      yield* TestClock.adjust("1 second");
      yield* f.fs.writeFileString(
        join(f.existing, "SKILL.md"),
        document("existing", "Later source refresh"),
      );
      yield* f.importSource([
        { name: "existing", path: f.existing },
        { name: "introduced", path: f.introduced },
      ]);
      const refreshed = yield* f.home.durable;
      expect(enabledSkillIds(refreshed, f.enabled)).toHaveLength(2);
      expect(
        currentSkillVersion(
          refreshed,
          refreshed.skills.find((skill) => skill.skill_id === prior.skill_id)!,
        )?.skill_version_id,
      ).not.toBe(currentSkillVersion(f.before, prior)?.skill_version_id);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a source inverse already published before a settings failure is not appended again on retry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      const failure = yield* Effect.flip(
        f.home.owned(
          inverse.apply().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...f.fs,
              rename: (from, to) =>
                to === join(f.home.home, "machine.json")
                  ? Effect.fail(
                      systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                      }),
                    )
                  : f.fs.rename(from, to),
            }),
          ),
        ),
      );
      expect(failure._tag).toBe("PlatformError");
      const partial = yield* f.home.durable;
      expect(enabledSkillIds(partial, f.enabled)).toHaveLength(1);
      expect((yield* Effect.flip(f.home.owned(inverse.apply())))._tag).toBe("PlanIsStale");
      const refreshed = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(refreshed.summary.conflicts).toEqual([]);
      expect(refreshed.summary.sourceSelections).toEqual([]);
      expect(refreshed.summary.intentChanged).toBe(false);
      yield* f.home.owned(refreshed.apply());
      expect((yield* f.home.durable).imports).toEqual(partial.imports);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "undo refuses corrupted retained source bytes and does not change the active source",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const original = sourceImports(f.before, f.collectionId)[0];
      const copy = f.before.collection_versions.find(
        (item) => item.collection_version_id === original.collection_version_id,
      )!;
      const path = join(
        collectionVersionPath(join(f.home.home, "originals"), copy.digest),
        "existing",
        "SKILL.md",
      );
      yield* f.fs.writeFileString(path, "Corrupted retained snapshot");
      const current = yield* f.home.durable;
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toContain(
        `Prior retained source bytes changed: ${f.collectionId}`,
      );
      expect((yield* Effect.flip(f.home.owned(inverse.apply())))._tag).toBe("RecoveryInvalid");
      expect(yield* f.home.durable).toEqual(current);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "source restoration refuses a clock behind the current observation instead of fabricating precedence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00.000Z"));
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toContain(
        `Clock has not advanced past the current source observation: ${f.collectionId}`,
      );
      expect((yield* Effect.flip(f.home.owned(inverse.apply())))._tag).toBe("RecoveryInvalid");
      expect(enabledSkillIds(yield* f.home.durable, f.enabled)).toHaveLength(2);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "undo refuses a newer differing source selection while preserving the latest membership",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(
        join(f.introduced, "SKILL.md"),
        document("introduced", "Newer source choice"),
      );
      yield* f.importSource([
        { name: "existing", path: f.existing },
        { name: "introduced", path: f.introduced },
      ]);
      yield* TestClock.adjust("1 second");
      const current = yield* f.home.durable;
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toContain(
        `Collection source changed after setup: ${f.collectionId}`,
      );
      expect((yield* Effect.flip(f.home.owned(inverse.apply())))._tag).toBe("RecoveryInvalid");
      expect(yield* f.home.durable).toEqual(current);
      expect(enabledSkillIds(current, f.enabled)).toHaveLength(2);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "source imports return a fresh-review continuation for changed desired versions without projecting unreviewed bytes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, false, true);
      const original = f.before.installed_skills[0];
      expect(f.applied?.changes?.find((item) => item.path === original.path)?.status).toBe(
        "pending",
      );
      expect(f.applied?.changes?.find((item) => item.path === original.path)?.reason).toContain(
        "review",
      );
      expect(yield* f.fs.readFileString(join(original.path, "SKILL.md"))).toBe(
        document("existing", "Before setup"),
      );
      expect((yield* f.home.durable).installed_skills).toEqual(f.before.installed_skills);
      const scan = yield* f.home.owned(
        runSetup({ ...f.options, persistRoots: false, repositoryRoots: [f.root] }),
      );
      const input = {
        options: f.options,
        workDirFlag: f.root,
        manageOptions: { installOptions: f.home.installOptions },
        planId: scan.onboarding.planId,
        selection: {
          sourceIds: [],
          copyPaths: [],
          removePaths: [],
          reconcileSkillIds: [original.skill_id],
        },
      };
      const interaction = yield* makeScriptedInteraction([]);
      const review = yield* f.home.owned(
        prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
      );
      expect(review.plan.canApply).toBe(true);
      expect(review.plan.summary.sources).toEqual([]);
      const reconciled = yield* f.home.owned(
        setupApplyCommand({ ...input, reviewedPlanId: review.plan.reviewId }).pipe(
          Effect.provide(interaction.layer),
        ),
      );
      expect(yield* f.fs.readFileString(join(original.path, "SKILL.md"))).toBe(
        document("existing", "Setup source update"),
      );
      if (!reconciled.operationId) return yield* Effect.die(new Error("Missing update inverse"));
      const undoUpdate = yield* f.home.owned(prepareSetupUndo(reconciled.operationId));
      expect(undoUpdate.summary.conflicts).toEqual([]);
      yield* f.home.owned(undoUpdate.apply());
      const undoImport = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(undoImport.summary.conflicts).toEqual([]);
      yield* f.home.owned(undoImport.apply());
      expect(yield* f.fs.readFileString(join(original.path, "SKILL.md"))).toBe(
        document("existing", "Before setup"),
      );
      const state = yield* f.home.durable;
      expect(state.installed_skills).toEqual(f.before.installed_skills);
      expect(
        currentSkillVersion(
          state,
          state.skills.find((skill) => skill.skill_id === original.skill_id)!,
        )?.skill_version_id,
      ).toBe(original.skill_version_id);
    }).pipe(Effect.provide(skitLayer)),
);
