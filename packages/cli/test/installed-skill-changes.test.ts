import { join } from "node:path";
import { systemError } from "effect/PlatformError";
import { Clock, Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  LibraryStore,
  libraryStateRevision,
  installEnabledSkills,
  skitLayer,
} from "@smolai/skit-core";
import { prepareSetupCommand, setupApplyCommand } from "../src/handlers/library/setup-machine.js";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { setupCommand } from "../src/handlers/library/setup.js";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import type { CommandAction } from "../src/commands/command-actions.js";
import { captureSetupFile } from "../src/library-application/setup-operation.js";
import {
  inspectRecoveryOperation,
  listRecoveryOperations,
} from "../src/library-application/recovery-moves.js";
import { prepareSetupUndo } from "../src/library-application/setup-undo.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import {
  deterministicTreeHash,
  libraryHome,
  importCollectionIn,
  scratch,
  writingTo,
} from "./helpers/library-home.js";

const document = (body: string) => `---\nname: review\ndescription: Review code\n---\n\n${body}\n`;
const fixture = Effect.fn("Test.setupReconciliation")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-reconcile-"));
  const source = join(root, "source", "review");
  const agents = join(root, "agents");
  const claude = join(root, "claude");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(agents);
  yield* fs.makeDirectory(claude);
  yield* fs.writeFileString(join(source, "SKILL.md"), document("Original baseline"));
  const copy = join(agents, "review");
  yield* fs.symlink(source, copy);
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: [agents], "claude-code": [claude] },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    persistRoots: false,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00.000Z"));
  const initial = yield* home.owned(runSetup(options));
  const interaction = yield* makeScriptedInteraction([]);
  yield* home.owned(
    setupApplyCommand({
      options,
      manageOptions: { bindings: home.bindings },
      planId: initial.onboarding.planId,
    }).pipe(Effect.provide(interaction.layer)),
  );
  const observe = home.owned(runSetup(options));
  const update = Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    yield* fs.writeFileString(join(source, "SKILL.md"), document("Incoming retained update"));
    yield* writingTo(
      home.home,
      importCollectionIn(home.home)({
        input: source,
        source: { type: "local", path: source },
        importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        observations: [],
        skills: [
          {
            name: "review",
            sourcePath: source,
            relativePath: ".",
            observedHash: yield* deterministicTreeHash(source),
          },
        ],
      }),
    );
  });
  const apply = Effect.gen(function* () {
    const observation = yield* observe;
    const interaction = yield* makeScriptedInteraction([]);
    return yield* home.owned(
      setupApplyCommand({
        options,
        manageOptions: { bindings: home.bindings },
        planId: observation.onboarding.planId,
      }).pipe(Effect.provide(interaction.layer)),
    );
  });
  return { fs, root, source, agents, claude, copy, home, options, observe, update, apply };
});

it.effect(
  "routine reconciliation leaves an unrelated edited Skill and its installed metadata untouched",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const otherSource = join(f.root, "other-source");
      yield* f.fs.makeDirectory(otherSource);
      const otherBytes = document("Other baseline").replace("name: review", "name: other");
      yield* f.fs.writeFileString(join(otherSource, "SKILL.md"), otherBytes);
      yield* writingTo(
        f.home.home,
        importCollectionIn(f.home.home)({
          input: otherSource,
          source: { type: "local", path: otherSource },
          importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          observations: [],
          skills: [
            {
              name: "other",
              sourcePath: otherSource,
              relativePath: ".",
              observedHash: yield* deterministicTreeHash(otherSource),
            },
          ],
        }),
      );
      yield* f.home.owned(
        writingTo(
          f.home.home,
          Effect.gen(function* () {
            const store = yield* LibraryStore;
            const state = yield* store.load;
            const other = state.skills.find((skill) => skill.name === "other")!;
            yield* store.save(
              {
                ...state,
                enabled: [...state.enabled, { skill: other.skill_id }],
              },
              state,
            );
            yield* installEnabledSkills({
              target: "agents",
              root: f.agents,
              variantsPath: store.variantsPath,
              onlySkillIds: [other.skill_id],
            });
          }),
        ),
      );
      const otherPath = join(f.agents, "other");
      const edited = document("Independent other edits").replace("name: review", "name: other");
      yield* f.fs.writeFileString(join(otherPath, "SKILL.md"), edited);
      const before = (yield* f.home.durable).installed_skills.find(
        (item) => item.path === otherPath,
      );
      yield* f.update;
      const applied = yield* f.apply;
      expect(
        applied.changes?.some((item) => item.path === otherPath && item.status === "local-kept"),
      ).toBe(true);
      expect(
        (yield* f.home.durable).installed_skills.find((item) => item.path === otherPath),
      ).toEqual(before);
      expect(yield* f.fs.readFileString(join(otherPath, "SKILL.md"))).toBe(edited);
      expect(yield* f.fs.exists(join(f.claude, "other"))).toBe(false);
      expect(yield* f.fs.exists(join(f.home.home, "variants", "agents", "other"))).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "reviewed incoming updates are installed at their captured targets and full undo restores the former copies",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const beforeFiles = [
        yield* f.fs.readFileString(join(f.copy, "SKILL.md")),
        yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md")),
      ];
      yield* f.update;
      const before = yield* f.home.durable;
      const applied = yield* f.apply;
      expect(applied.changes?.map((item) => item.status)).toEqual(["updated", "updated"]);
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
        document("Incoming retained update"),
      );
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(
        document("Incoming retained update"),
      );
      if (!applied.operationId)
        return yield* Effect.die(new Error("Missing reconciliation inverse evidence"));
      const inverse = yield* f.home.owned(prepareSetupUndo(applied.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      yield* f.home.owned(inverse.apply());
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(beforeFiles[0]);
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(beforeFiles[1]);
      const undone = yield* f.home.durable;
      expect(undone.installed_skills).toEqual(before.installed_skills);
      expect(undone.skills).toEqual(before.skills);
      expect(undone.collection_versions).toEqual(before.collection_versions);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "local-only edits stay active without a question, version change or ownership rewrite",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), document("User local edits"));
      const before = yield* f.home.durable;
      const marker = yield* f.fs.readFileString(join(f.copy, ".skit-ownership.json"));
      const applied = yield* f.apply;
      expect(
        applied.changes?.some((item) => item.path === f.copy && item.status === "local-kept"),
      ).toBe(true);
      expect(applied.operationId).toBeUndefined();
      expect(yield* f.home.durable).toEqual(before);
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
        document("User local edits"),
      );
      expect(yield* f.fs.readFileString(join(f.copy, ".skit-ownership.json"))).toBe(marker);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("competing changes fail usefully before any update or inverse record is written", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.update;
    yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), document("Competing user edits"));
    const before = yield* f.home.durable;
    const removed = yield* f.fs.readDirectory(join(f.home.home, "removed"));
    const failed = yield* Effect.flip(f.apply);
    expect(failed._tag).toBe("ChangeChoiceRequired");
    expect(yield* f.home.durable).toEqual(before);
    expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
      document("Competing user edits"),
    );
    expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(
      document("Original baseline"),
    );
    expect(yield* f.fs.readDirectory(join(f.home.home, "removed"))).toEqual(removed);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an explicit empty selection leaves existing pending updates untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.update;
    const observed = yield* f.observe;
    const input = {
      options: f.options,
      manageOptions: { bindings: f.home.bindings },
      planId: observed.onboarding.planId,
      selection: { sourceIds: [], copyPaths: [], removePaths: [] },
    };
    const interaction = yield* makeScriptedInteraction([]);
    const plan = yield* f.home.owned(
      prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
    );
    expect(plan.plan.summary.changes).toEqual([]);
    expect(plan.plan.hasChanges).toBe(false);
    const recommended = yield* f.home.owned(
      prepareSetupCommand({ ...input, selection: undefined }).pipe(
        Effect.provide(interaction.layer),
      ),
    );
    expect(recommended.plan.reviewId).not.toBe(plan.plan.reviewId);
    const wrongScope = yield* f.home.owned(
      setupApplyCommand({
        ...input,
        selection: undefined,
        reviewedPlanId: plan.plan.reviewId,
      }).pipe(Effect.provide(interaction.layer), Effect.result),
    );
    expect(wrongScope._tag).toBe("Failure");
    const applied = yield* f.home.owned(
      setupApplyCommand({ ...input, reviewedPlanId: plan.plan.reviewId }).pipe(
        Effect.provide(interaction.layer),
      ),
    );
    expect(applied.operationId).toBeUndefined();
    expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
      document("Original baseline"),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "enabling one explicit setup selection cannot rewrite an unrelated copy with disputed ownership",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const edited = document("Unrelated newer user contents");
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), edited);
      const markerPath = join(f.copy, ".skit-ownership.json");
      const marker = JSON.parse(yield* f.fs.readFileString(markerPath));
      yield* f.fs.writeFileString(
        markerPath,
        JSON.stringify({ ...marker, expected_digest: yield* deterministicTreeHash(f.copy) }),
      );
      const newCopy = join(f.agents, "another");
      yield* f.fs.makeDirectory(newCopy);
      yield* f.fs.writeFileString(
        join(newCopy, "SKILL.md"),
        document("New selected Skill").replace("name: review", "name: another"),
      );
      const observed = yield* f.observe;
      expect(observed.changes?.find((fact) => fact.path === f.copy)?.status).toBe("protected");
      const before = (yield* f.home.durable).installed_skills.find((item) => item.path === f.copy);
      const input = {
        options: f.options,
        manageOptions: { bindings: f.home.bindings },
        planId: observed.onboarding.planId,
        selection: { sourceIds: [], copyPaths: [newCopy], removePaths: [] },
      };
      const interaction = yield* makeScriptedInteraction([]);
      const prepared = yield* f.home.owned(
        prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
      );
      expect(prepared.plan.canApply).toBe(true);
      yield* f.home.owned(
        setupApplyCommand({ ...input, reviewedPlanId: prepared.plan.reviewId }).pipe(
          Effect.provide(interaction.layer),
        ),
      );
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(edited);
      expect((yield* f.home.durable).installed_skills.find((item) => item.path === f.copy)).toEqual(
        before,
      );
      expect(yield* f.fs.exists(join(newCopy, ".skit-ownership.json"))).toBe(true);
    }).pipe(Effect.provide(skitLayer)),
);

for (const scenario of [
  "aligned",
  "incoming",
  "local",
  "competing",
  "equal-current-desired",
] as const) {
  it.effect(
    `classifies ${scenario} from real last-written, installed and rendered retained bytes without changing them`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        if (scenario === "local" || scenario === "competing")
          yield* f.fs.writeFileString(
            join(f.copy, "SKILL.md"),
            document("Independent local edits"),
          );
        if (
          scenario === "incoming" ||
          scenario === "competing" ||
          scenario === "equal-current-desired"
        )
          yield* f.update;
        if (scenario === "equal-current-desired")
          yield* f.fs.writeFileString(
            join(f.copy, "SKILL.md"),
            document("Incoming retained update"),
          );
        const before = yield* f.home.durable;
        const stateBytes = yield* f.fs.readFileString(join(f.home.home, "state.json"));
        const settingsBytes = yield* f.fs.readFileString(join(f.home.home, "machine.json"));
        const installed = yield* f.fs.readFileString(join(f.copy, "SKILL.md"));
        const observed = yield* f.observe;
        const fact = observed.changes?.find((item) => item.path === f.copy);
        expect(fact?.status).toBe(
          {
            aligned: "unchanged",
            incoming: "incoming-update",
            local: "local-only",
            competing: "competing",
            "equal-current-desired": "unchanged",
          }[scenario],
        );
        expect(fact?.currentHash).toBe(yield* deterministicTreeHash(f.copy));
        expect(fact?.metadataChanged).toBe(scenario === "equal-current-desired");
        expect(libraryStateRevision(yield* f.home.durable)).toBe(libraryStateRevision(before));
        expect(yield* f.fs.readFileString(join(f.home.home, "state.json"))).toBe(stateBytes);
        expect(yield* f.fs.readFileString(join(f.home.home, "machine.json"))).toBe(settingsBytes);
        expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(installed);
        expect((yield* f.observe).onboarding.planId).toBe(observed.onboarding.planId);
      }).pipe(Effect.provide(skitLayer)),
  );
}

it.effect("a changed marker cannot redefine the Library baseline", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* f.observe;
    const markerPath = join(f.copy, ".skit-ownership.json");
    const marker = JSON.parse(yield* f.fs.readFileString(markerPath));
    yield* f.fs.writeFileString(
      markerPath,
      JSON.stringify({ ...marker, expected_digest: `sha256:${"f".repeat(64)}` }),
    );
    const observed = yield* f.observe;
    expect(observed.changes?.find((item) => item.path === f.copy)?.status).toBe("protected");
    expect(observed.onboarding.planId).not.toBe(before.onboarding.planId);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "native deletion remains absent and a leaf symlink never grants ownership of its target",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const saved = join(f.root, "saved-copy");
      yield* f.fs.rename(f.copy, saved);
      const missing = yield* f.observe;
      expect(missing.changes?.find((item) => item.path === f.copy)?.status).toBe("native-delete");
      expect(yield* f.fs.exists(f.copy)).toBe(false);
      const bytes = yield* f.fs.readFileString(join(saved, "SKILL.md"));
      yield* f.fs.symlink(saved, f.copy);
      expect((yield* f.observe).changes?.find((item) => item.path === f.copy)?.status).toBe(
        "protected",
      );
      expect(yield* f.fs.readFileString(join(saved, "SKILL.md"))).toBe(bytes);
      expect(yield* f.fs.readLink(f.copy)).toBe(saved);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "routine updates preserve native deletion and undo leaves a later independent native restoration active",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const saved = join(f.root, "native-removed-copy");
      yield* f.fs.rename(f.copy, saved);
      yield* f.update;
      const applied = yield* f.apply;
      expect(
        applied.changes?.some((item) => item.path === f.copy && item.status === "native-delete"),
      ).toBe(true);
      expect(yield* f.fs.exists(f.copy)).toBe(false);
      yield* f.fs.rename(saved, f.copy);
      const restoredByUser = document("Later independent native restoration and edits");
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), restoredByUser);
      if (!applied.operationId) return yield* Effect.die(new Error("Missing update operation"));
      const inverse = yield* f.home.owned(prepareSetupUndo(applied.operationId));
      expect(inverse.summary.conflicts).toEqual([]);
      yield* f.home.owned(inverse.apply());
      expect(yield* f.fs.exists(f.copy)).toBe(true);
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(restoredByUser);
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(
        document("Original baseline"),
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("excluded control bytes participate in reconciliation approval evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* f.observe;
    yield* f.fs.writeFileString(join(f.copy, ".DS_Store"), "New independent bytes");
    const after = yield* f.observe;
    const left = before.changes!.find((item) => item.path === f.copy)!;
    const right = after.changes!.find((item) => item.path === f.copy)!;
    expect(left.status).toBe("unchanged");
    expect(right.status).toBe("unchanged");
    expect(right.currentHash).toBe(left.currentHash);
    expect(right.evidence).not.toBe(left.evidence);
    expect(after.onboarding.planId).not.toBe(before.onboarding.planId);
  }).pipe(Effect.provide(skitLayer)),
);

const invoke = Effect.fn("Test.reconcileAction")(function* (argv: readonly string[]) {
  const interaction = yield* makeScriptedInteraction([]);
  yield* runCommandTree(skitCommand, argv.slice(1), "test").pipe(Effect.provide(interaction.layer));
  expect(yield* interaction.failures).toEqual([]);
  const results = yield* interaction.results;
  expect(results).toHaveLength(1);
  return results[0];
});
const actionFor = (actions: readonly CommandAction[], rel: string) => {
  const action = actions.find((item) => item.rel === rel);
  if (!action) throw new Error(`Missing ${rel}`);
  return action;
};
it.effect(
  "literal per-Skill discovery actions review and apply incoming bytes without selecting unrelated sources",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.update;
      const discovery = yield* invoke([
        "skit",
        "setup",
        "--json",
        "--home",
        f.home.home,
        "--codex-root",
        f.agents,
        "--claude-root",
        f.claude,
        "--opencode-root",
        join(f.root, "opencode"),
      ]);
      if (discovery.contract !== "setup") return yield* Effect.die(new Error("Expected discovery"));
      const choice = discovery.data.choices.find(
        (item) => item.kind === "existing" && item.label === "review",
      );
      if (!choice) return yield* Effect.die(new Error("Missing existing Skill choice"));
      const reviewAction = actionFor(choice.actions, "review");
      expect(reviewAction.argv).toContain("--only-selected");
      expect(reviewAction.argv).toContain("--reconcile-skill");
      const review = yield* invoke(reviewAction.argv);
      if (review.contract !== "setupReview") return yield* Effect.die(new Error("Expected review"));
      expect(review.data.canApply).toBe(true);
      expect(review.data.summary.sources).toEqual([]);
      expect(review.data.summary.changes.every((fact) => fact.skillId === choice.skillId)).toBe(
        true,
      );
      const applied = yield* invoke(actionFor(review.data.actions, "apply").argv);
      if (applied.contract !== "setupApplied")
        return yield* Effect.die(new Error("Expected applied"));
      expect(applied.data.changes?.filter((item) => item.status === "updated")).toHaveLength(2);
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
        document("Incoming retained update"),
      );
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(
        document("Incoming retained update"),
      );
    }).pipe(Effect.provide(skitLayer)),
);

for (const chosen of ["retained", "local"] as const) {
  it.effect(
    `explicit ${chosen} choice preserves competing directories, installs intended bytes and fully undoes`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.update;
        const edited = document("Competing user version");
        yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), edited);
        yield* f.fs.writeFileString(join(f.copy, ".DS_Store"), "Independent control bytes");
        yield* f.fs.makeDirectory(join(f.copy, "empty"));
        const before = yield* f.home.durable;
        const observed = yield* f.observe;
        const fact = observed.changes!.find((item) => item.path === f.copy)!;
        expect(fact.status).toBe("competing");
        const input = {
          options: f.options,
          manageOptions: { bindings: f.home.bindings },
          planId: observed.onboarding.planId,
          selection: {
            sourceIds: [],
            copyPaths: [],
            removePaths: [],
            ...(chosen === "retained"
              ? { useRetainedSkillIds: [fact.skillId] }
              : { useCopyPaths: [f.copy] }),
          },
        };
        const interaction = yield* makeScriptedInteraction([]);
        const review = yield* f.home.owned(
          prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
        );
        expect(review.plan.canApply).toBe(true);
        expect(review.plan.summary.versionChoices).toHaveLength(1);
        const applied = yield* f.home.owned(
          setupApplyCommand({ ...input, reviewedPlanId: review.plan.reviewId }).pipe(
            Effect.provide(interaction.layer),
          ),
        );
        const expected = chosen === "retained" ? document("Incoming retained update") : edited;
        expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(expected);
        expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(expected);
        if (!applied.operationId) return yield* Effect.die(new Error("Missing inverse"));
        const saved = yield* inspectRecoveryOperation(f.home.home, applied.operationId);
        const displaced = saved.entries.find((entry) => entry.path === f.copy)!;
        expect(yield* f.fs.readFileString(join(displaced.recoveryPath, "SKILL.md"))).toBe(edited);
        expect(yield* f.fs.readFileString(join(displaced.recoveryPath, ".DS_Store"))).toBe(
          "Independent control bytes",
        );
        expect(yield* f.fs.readDirectory(join(displaced.recoveryPath, "empty"))).toEqual([]);
        const undo = yield* f.home.owned(prepareSetupUndo(applied.operationId));
        expect(undo.summary.conflicts).toEqual([]);
        yield* f.home.owned(undo.apply());
        expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(edited);
        expect(yield* f.fs.readFileString(join(f.copy, ".DS_Store"))).toBe(
          "Independent control bytes",
        );
        expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(
          document("Original baseline"),
        );
        const after = yield* f.home.durable;
        expect(after.installed_skills).toEqual(before.installed_skills);
        expect(after.skills.map((skill) => skill.local_version_id)).toEqual(
          before.skills.map((skill) => skill.local_version_id),
        );
        expect(after.collection_versions.length).toBeGreaterThanOrEqual(
          before.collection_versions.length,
        );
        expect(after.imports.length).toBeGreaterThanOrEqual(before.imports.length);
      }).pipe(Effect.provide(skitLayer)),
  );
}

it.effect("metadata-only alignment keeps the directory and excluded user content in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.update;
    yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), document("Incoming retained update"));
    yield* f.fs.writeFileString(join(f.copy, ".DS_Store"), "Keep this control entry");
    yield* f.fs.makeDirectory(join(f.copy, "empty"));
    const before = yield* captureSetupFile(f.copy);
    const fact = (yield* f.observe).changes!.find((item) => item.path === f.copy)!;
    expect(fact.status).toBe("unchanged");
    expect(fact.metadataChanged).toBe(true);
    yield* f.apply;
    const after = yield* captureSetupFile(f.copy);
    expect(after.entry?.ino).toBe(before.entry?.ino);
    expect(after.entry?.unstampedHash).toBe(before.entry?.unstampedHash);
    expect(after.entry?.marker).not.toBe(before.entry?.marker);
    expect(yield* f.fs.readFileString(join(f.copy, ".DS_Store"))).toBe("Keep this control entry");
    expect(yield* f.fs.readDirectory(join(f.copy, "empty"))).toEqual([]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a local version choice keeps a native-deleted sibling absent", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.update;
    yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), document("Chosen local edits"));
    const sibling = join(f.claude, "review");
    yield* f.fs.rename(sibling, join(f.root, "removed-by-user"));
    const observed = yield* f.observe;
    const input = {
      options: f.options,
      manageOptions: { bindings: f.home.bindings },
      planId: observed.onboarding.planId,
      selection: { sourceIds: [], copyPaths: [], removePaths: [], useCopyPaths: [f.copy] },
    };
    const interaction = yield* makeScriptedInteraction([]);
    const review = yield* f.home.owned(
      prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
    );
    const applied = yield* f.home.owned(
      setupApplyCommand({ ...input, reviewedPlanId: review.plan.reviewId }).pipe(
        Effect.provide(interaction.layer),
      ),
    );
    expect(applied.changes?.find((item) => item.path === sibling)?.status).toBe("native-delete");
    expect(yield* f.fs.exists(sibling)).toBe(false);
    expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
      document("Chosen local edits"),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "full undo recovers an interrupted version choice between its preserved-directory moves",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.update;
      const edited = document("Chosen local edits before interruption");
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), edited);
      const before = yield* f.home.durable;
      const existing = new Set(yield* listRecoveryOperations(f.home.home));
      const observed = yield* f.observe;
      const input = {
        options: f.options,
        manageOptions: { bindings: f.home.bindings },
        planId: observed.onboarding.planId,
        selection: { sourceIds: [], copyPaths: [], removePaths: [], useCopyPaths: [f.copy] },
      };
      const interaction = yield* makeScriptedInteraction([]);
      const review = yield* f.home.owned(
        prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
      );
      let moves = 0;
      const failed = yield* f.home.owned(
        setupApplyCommand({ ...input, reviewedPlanId: review.plan.reviewId }).pipe(
          Effect.provide(interaction.layer),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) => {
              if (from === f.copy || from === join(f.claude, "review")) {
                moves++;
                if (moves === 2)
                  return Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: from,
                    }),
                  );
              }
              return f.fs.rename(from, to);
            },
          }),
          Effect.result,
        ),
      );
      expect(failed._tag).toBe("Failure");
      expect(moves).toBe(2);
      const operationId = (yield* listRecoveryOperations(f.home.home)).find(
        (id) => !existing.has(id),
      )!;
      expect(
        (yield* inspectRecoveryOperation(f.home.home, operationId)).entries.some(
          (entry) => entry.status === "saved",
        ),
      ).toBe(true);
      const undo = yield* f.home.owned(prepareSetupUndo(operationId));
      expect(undo.summary.conflicts).toEqual([]);
      yield* f.home.owned(undo.apply());
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(edited);
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(
        document("Original baseline"),
      );
      const after = yield* f.home.durable;
      expect(after.installed_skills).toEqual(before.installed_skills);
      expect(after.skills.map((skill) => skill.local_version_id)).toEqual(
        before.skills.map((skill) => skill.local_version_id),
      );
      expect(after.imports.length).toBeGreaterThan(before.imports.length);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("a settings-only work-dir call never applies pending installed updates", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.update;
    const before = (yield* f.home.durable).installed_skills;
    const work = join(f.root, "new-work-root");
    yield* f.fs.makeDirectory(work);
    const interaction = yield* makeScriptedInteraction([]);
    const applied = yield* f.home.owned(
      setupCommand({
        options: f.options,
        manageOptions: { bindings: f.home.bindings },
        workDirFlag: work,
        interactive: false,
        dryRun: false,
      }).pipe(Effect.provide(interaction.layer)),
    );
    expect("operationId" in applied && applied.operationId).toBeTruthy();
    expect((yield* f.home.durable).installed_skills).toEqual(before);
    expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
      document("Original baseline"),
    );
    expect(applied.changes?.find((fact) => fact.path === f.copy)?.status).toBe("incoming-update");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a generic client resolves competing edits through returned version actions and stale control bytes refuse apply",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.update;
      const edited = document("Chosen through concrete CLI actions");
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), edited);
      const argv = [
        "skit",
        "setup",
        "--json",
        "--home",
        f.home.home,
        "--codex-root",
        f.agents,
        "--claude-root",
        f.claude,
        "--opencode-root",
        join(f.root, "opencode"),
      ];
      const discovered = yield* invoke(argv);
      if (discovered.contract !== "setup")
        return yield* Effect.die(new Error("Expected discovery"));
      const existing = discovered.data.choices.find(
        (item) => item.kind === "existing" && item.label === "review",
      )!;
      const unresolved = yield* invoke(actionFor(existing.actions, "review").argv);
      if (unresolved.contract !== "setupReview")
        return yield* Effect.die(new Error("Expected unresolved review"));
      expect(unresolved.data.canApply).toBe(false);
      expect(unresolved.data.actions.some((action) => action.effect === "write")).toBe(false);
      const local = discovered.data.choices.find(
        (item) => item.kind === "version" && item.path === f.copy,
      )!;
      expect(unresolved.data.actions).toContainEqual(actionFor(local.actions, "review"));
      const compared = yield* invoke(actionFor(local.actions, "compare").argv);
      expect(compared.contract).toBe("setupComparison");
      if (compared.contract === "setupComparison")
        expect(compared.data.actions).toContainEqual(actionFor(local.actions, "review"));
      const reviewed = yield* invoke(actionFor(local.actions, "review").argv);
      if (reviewed.contract !== "setupReview")
        return yield* Effect.die(new Error("Expected chosen review"));
      expect(reviewed.data.canApply).toBe(true);
      const rendered = renderContract(reviewed, { color: false, detail: "full" });
      expect(rendered).toContain("preserve displaced copies in recovery");
      expect(rendered).toContain("Install selected version");
      expect(rendered).not.toContain("choose the active version");
      const before = yield* f.home.durable;
      const operations = yield* listRecoveryOperations(f.home.home);
      yield* f.fs.writeFileString(join(f.copy, ".DS_Store"), "Control bytes changed after review");
      const stale = yield* invoke(actionFor(reviewed.data.actions, "apply").argv);
      expect(stale.contract).toBe("setupFailed");
      expect(stale.exitCode).not.toBe(0);
      expect(yield* f.home.durable).toEqual(before);
      expect(yield* listRecoveryOperations(f.home.home)).toEqual(operations);
      const refreshed = yield* invoke(argv);
      if (refreshed.contract !== "setup")
        return yield* Effect.die(new Error("Expected fresh discovery"));
      const freshChoice = refreshed.data.choices.find(
        (item) => item.kind === "version" && item.path === f.copy,
      )!;
      const freshReview = yield* invoke(actionFor(freshChoice.actions, "review").argv);
      if (freshReview.contract !== "setupReview")
        return yield* Effect.die(new Error("Expected fresh review"));
      const applied = yield* invoke(actionFor(freshReview.data.actions, "apply").argv);
      expect(applied.contract).toBe("setupApplied");
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(edited);
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(edited);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "guided setup selects the same shared active-version alternative and renders its result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.update;
      const edited = document("Local version selected in guided setup");
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), edited);
      const interaction = yield* makeScriptedInteraction(["1", true]);
      yield* f.home.owned(
        setupCommand({
          options: f.options,
          manageOptions: { bindings: f.home.bindings },
          interactive: true,
          dryRun: false,
        }).pipe(Effect.provide(interaction.layer)),
      );
      const prompts = yield* interaction.prompts;
      expect(prompts.map((prompt) => prompt.kind)).toEqual(["select", "confirm"]);
      expect(prompts[0].message).toContain("Which version of review");
      expect(prompts[0].choices[1].label).toContain("~/agents/review");
      expect(yield* interaction.remaining).toBe(0);
      const notes = yield* interaction.notes;
      expect(notes.find((note) => note.title === "Setup complete")?.body).toContain(
        "Updated active copy",
      );
      expect(notes.find((note) => note.title === "Setup complete")?.body).toContain(
        "Preview full undo",
      );
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(edited);
      expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(edited);
    }).pipe(Effect.provide(skitLayer)),
);
