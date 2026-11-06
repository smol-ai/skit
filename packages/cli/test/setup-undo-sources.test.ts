import { readLibraryManifest } from "./helpers/library-manifest.js";
import { originalTreePath } from "./helpers/original-tree.js";
import { withLibraryOwner } from "./helpers/library-owner.js";
import { installEnabledSkills } from "./helpers/installed-skills.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Clock, Effect, FileSystem, Option } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";
import { expect } from "vitest";

import type { LibraryFixtureState as LibraryState } from "./helpers/library-home.js";
import * as MachineSettings from "@smolai/skit-core/machine-settings";
import { skitLayer } from "@smolai/skit-core/platform";
import { skillsDirectoryFor } from "@smolai/skit-core/library/routing";
import { prepareSetupCommand, setupApplyCommand } from "../src/library/setup/apply.js";
import { prepareSetupUndo } from "../src/library/setup/undo.js";
import { setupSourceChoiceId, runSetup, setupIntent } from "@smolai/skit-core/library/setup";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";

import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { renderContract } from "../src/commands/output-presenters.js";
import * as Library from "@smolai/skit-core/library";
import { openSyncSession } from "@smolai/skit-core/library/session";
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
  interruptAfterImport = false,
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
  yield* home.writeDurable(before);
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
  // Unprojected, the recommended plan would also install the enabled Collection, which the source
  // import changes after review and so stops the setup: approve the source import alone.
  const input = {
    options,
    workDirFlag: root,
    manageOptions: { installOptions: home.installOptions },
    planId: scan.onboarding.planId,
    ...(projectExisting
      ? {}
      : {
          selection: {
            sourceIds: scan.onboarding.recommended.sources.map((source) =>
              setupSourceChoiceId(source.groupKey),
            ),
            copyPaths: [],
            removePaths: [],
          },
        }),
  };
  let saves = 0;
  const executed = yield* Effect.exit(
    home.owned(
      Effect.gen(function* () {
        const reviewed = projectExisting
          ? undefined
          : (yield* prepareSetupCommand(input)).plan.reviewId;
        return yield* setupApplyCommand({
          ...input,
          ...(reviewed === undefined ? {} : { reviewedPlanId: reviewed }),
        });
      }).pipe(
        Effect.provide(interaction.layer),
        // The record is the first state.json replacement and the import the second: dying there
        // leaves it Pending.
        withLibraryOwner,
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            Effect.andThen(
              fs.rename(from, to),
              interruptAfterImport && to === home.statePath && ++saves === 2
                ? Effect.interrupt
                : Effect.void,
            ),
        }),
      ),
    ),
  );
  let operationId: string | undefined;
  if (interruptAfterImport) {
    expect(executed._tag).toBe("Failure");
    const saved: { operations: readonly { operationId: string }[] } = JSON.parse(
      yield* fs.readFileString(home.statePath),
    );
    operationId = saved.operations[0]?.operationId;
  } else {
    if (executed._tag === "Failure") return yield* Effect.failCause(executed.cause);
    operationId = executed.value.operationId;
  }
  if (!operationId) return yield* Effect.die(new Error("Setup omitted operation evidence"));
  yield* TestClock.adjust("1 second");
  return {
    fs,
    root,
    home,
    options,
    applied: executed._tag === "Success" ? executed.value : undefined,
    existing,
    introduced,
    before,
    importSource,
    operationId,
    collectionId,
  };
});

it.effect(
  "full undo reverses a setup interrupted after its import, once the next Library finished it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, true);
      // The next Library finished the setup the import was interrupted in.
      expect(
        setupIntent(yield* f.home.durable).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(2);
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      expect(inverse.summary.sourceSelections).toHaveLength(1);
      yield* f.home.owned(inverse.apply());
      expect(
        setupIntent(yield* f.home.durable).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(1);
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
      expect(
        setupIntent(yield* f.home.durable).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(1);
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
      expect(
        setupIntent(restored).versions.find((version) => version.skillId === skill.skill_id)
          ?.selected,
      ).toBe(
        setupIntent(f.before).versions.find(
          (version) => version.skillId === f.before.skills[0].skill_id,
        )?.selected,
      );
      expect(
        setupIntent(restored).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(1);
      expect(restored.collection_versions).toEqual(after.collection_versions);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "full undo restores followed source membership and versions without discarding any acquired bytes or freezing future refresh",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const after = yield* f.home.durable;
      expect(
        setupIntent(after).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(2);
      const afterManifest = yield* readLibraryManifest(f.home.home, [f.root]);
      const head = {
        library_id: "source-undo-library",
        revision_id: "after-setup",
        manifest: afterManifest,
      };
      // Establish the accepted after-setup base through the owner, before undo makes a local edit.
      yield* f.home.owned(
        Effect.gen(function* () {
          const library = yield* Library.Service;
          const base = yield* library.read;
          const session = yield* openSyncSession(
            { origin: "https://registry.test", remote: head },
            { base },
          );
          if (session._tag !== "Ready") return yield* Effect.die("Expected clean sync session");
          const staged = yield* library.content.stage(session.target, {
            localArchives: yield* library.content.pack(base),
            registry: { origin: "https://registry.test", token: Option.none() },
          });
          yield* (yield* session.prepare(staged)).apply(head);
        }),
      );
      const inverse = yield* f.home.owned(prepareSetupUndo(f.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      expect(inverse.summary.sourceSelections).toHaveLength(1);
      yield* f.home.owned(inverse.apply());
      const restored = yield* f.home.durable;
      expect(restored.enabled).toEqual(f.before.enabled);
      expect(
        setupIntent(restored).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toEqual([f.before.skills[0].skill_id]);
      expect(restored.skills).toHaveLength(2);
      expect(restored.collection_versions).toEqual(after.collection_versions);
      expect(restored.imports).toHaveLength(after.imports.length + 1);
      for (const sourceImport of after.imports)
        expect(restored.imports).toContainEqual(sourceImport);
      const prior = f.before.skills[0];
      const selected = restored.skills.find((skill) => skill.skill_id === prior.skill_id)!;
      expect(
        setupIntent(restored).versions.find((version) => version.skillId === selected.skill_id)
          ?.selected,
      ).toBe(
        setupIntent(f.before).versions.find((version) => version.skillId === prior.skill_id)
          ?.selected,
      );
      expect(selected.local_version_id).toBeUndefined();
      const restoredSource = setupIntent(restored).sources?.find(
        (source) => source.collectionId === f.collectionId,
      );
      const originalSource = setupIntent(f.before).sources?.find(
        (source) => source.collectionId === f.collectionId,
      );
      const observation = restored.imports.find(
        (sourceImport) => sourceImport.import_id === restoredSource?.importId,
      );
      const original = f.before.imports.find(
        (sourceImport) => sourceImport.import_id === originalSource?.importId,
      );
      if (!observation || !original)
        return yield* Effect.die("Missing selected source observation");
      expect(observation.collection_version_id).toBe(original.collection_version_id);
      expect(observation.lock_file_entries).toEqual([]);
      const copy = restored.collection_versions.find(
        (item) => item.collection_version_id === original.collection_version_id,
      )!;
      expect(observation.input.value).toBe(
        originalTreePath(join(f.home.home, "originals"), copy.hash),
      );
      const restoredManifest = yield* readLibraryManifest(f.home.home, [f.root]);
      expect(restoredManifest.imports).toEqual(restored.imports);
      const synced = yield* f.home.owned(
        Effect.gen(function* () {
          const library = yield* Library.Service;
          return yield* openSyncSession(
            { origin: "https://registry.test", remote: head },
            { base: yield* library.read },
          );
        }),
      );
      expect(synced._tag).toBe("Ready");
      if (synced._tag !== "Ready") return;
      expect(
        synced.target.collection_versions.find(
          (version) => version.collection_version_id === observation.collection_version_id,
        )?.members,
      ).toHaveLength(1);
      expect(
        synced.target.imports.toSorted((left, right) =>
          left.import_id.localeCompare(right.import_id),
        ),
      ).toEqual(
        restored.imports.toSorted((left, right) => left.import_id.localeCompare(right.import_id)),
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
      expect(
        setupIntent(refreshed).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(2);
      expect(
        setupIntent(refreshed).versions.find((version) => version.skillId === prior.skill_id)
          ?.selected,
      ).not.toBe(
        setupIntent(f.before).versions.find((version) => version.skillId === prior.skill_id)
          ?.selected,
      );
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
      expect(
        setupIntent(partial).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(1);
      expect((yield* Effect.flip(f.home.owned(inverse.apply())))._tag).toBe("Library.StalePlan");
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
      const originalSource = setupIntent(f.before).sources?.find(
        (source) => source.collectionId === f.collectionId,
      );
      const original = f.before.imports.find(
        (sourceImport) => sourceImport.import_id === originalSource?.importId,
      );
      if (!original) return yield* Effect.die("Missing selected source observation");
      const copy = f.before.collection_versions.find(
        (item) => item.collection_version_id === original.collection_version_id,
      )!;
      const path = join(
        originalTreePath(join(f.home.home, "originals"), copy.hash),
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
      expect(
        setupIntent(yield* f.home.durable).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(2);
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
      expect(
        setupIntent(current).memberships?.find(
          (membership) => membership.collectionId === f.collectionId,
        )?.skillIds,
      ).toHaveLength(2);
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
      expect(yield* f.fs.readFileString(join(original.path, "SKILL.md"))).toBe(
        document("existing", "Before setup"),
      );
      expect((yield* f.home.durable).installed_skills).toEqual(f.before.installed_skills);
      // The later setup replaced the import's record, so only the later one can be undone.
      const undoImport = yield* Effect.flip(f.home.owned(prepareSetupUndo(f.operationId)));
      expect(undoImport._tag).toBe("RecoveryInvalid");
    }).pipe(Effect.provide(skitLayer)),
);
