import { recoveryList } from "./helpers/recovery.js";
import * as Library from "@smolai/skit-core/library";

import { join } from "node:path";

import { Clock, Effect, FileSystem } from "effect";

import { TestClock } from "effect/testing";

import { it } from "@effect/vitest";

import { expect } from "vitest";

import { skitLayer } from "@smolai/skit-core/platform";

import { prepareSetupCommand, setupApplyCommand } from "../src/library/setup/apply.js";

import { setupCommand } from "../src/library/setup.js";
import { renderSetup } from "../src/library/setup/present.js";
import { renderBlocks } from "../src/terminal/blocks.js";

import { skitCommand } from "../src/commands/tree.js";

import { runCommandTree } from "../src/commands/runtime.js";

import type { CommandAction } from "../src/commands/command-actions.js";

import { runSetup } from "@smolai/skit-core/library/setup";

import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";

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
      manageOptions: { installOptions: home.installOptions },
      planId: initial.onboarding.planId,
    }).pipe(Effect.provide(interaction.layer)),
  );
  const scan = home.owned(runSetup(options));
  const update = Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    yield* fs.writeFileString(join(source, "SKILL.md"), document("Incoming retained update"));
    yield* writingTo(
      home.home,
      importCollectionIn(home.home)({
        input: source,
        source: { type: "local", path: source },
        importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        lockFileEntries: [],
        skills: [
          {
            name: "review",
            sourcePath: source,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(source),
          },
        ],
      }),
    );
  });
  const apply = Effect.gen(function* () {
    const lockFileEntry = yield* scan;
    const interaction = yield* makeScriptedInteraction([]);
    return yield* home.owned(
      setupApplyCommand({
        options,
        manageOptions: { installOptions: home.installOptions },
        planId: lockFileEntry.onboarding.planId,
      }).pipe(Effect.provide(interaction.layer)),
    );
  });
  return { fs, root, source, agents, claude, copy, home, options, observe: scan, update, apply };
});

for (const scenario of ["incoming", "local", "competing", "metadata"] as const) {
  it.effect(`setup reports ${scenario} managed changes without choosing or applying them`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (scenario === "incoming" || scenario === "competing") yield* f.update;
      if (scenario === "local" || scenario === "competing")
        yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), document("Local edits"));
      if (scenario === "metadata") {
        const marker = join(f.copy, ".skit-ownership.json");
        const contents = JSON.parse(yield* f.fs.readFileString(marker));
        yield* f.fs.writeFileString(
          marker,
          JSON.stringify({ ...contents, expected_hash: `sha256:${"f".repeat(64)}` }),
        );
      }
      const state = yield* f.home.durable;
      const bytes = yield* f.fs.readFileString(join(f.copy, "SKILL.md"));
      const marker = yield* f.fs.readFileString(join(f.copy, ".skit-ownership.json"));
      const recovery = yield* recoveryList(f.home.home);
      const scan = yield* f.observe;
      const input = {
        options: f.options,
        manageOptions: { installOptions: f.home.installOptions },
        planId: scan.onboarding.planId,
      };
      const interaction = yield* makeScriptedInteraction([]);
      const prepared = yield* f.home.owned(
        prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
      );
      expect(prepared.plan.hasChanges).toBe(false);
      expect(prepared.plan.summary).not.toHaveProperty("versionChoices");
      expect(prepared.review).not.toHaveProperty("versionAlternatives");
      const applied = yield* f.apply;
      expect(applied.operationId).toBeUndefined();
      expect(applied).not.toHaveProperty("changes");
      expect(yield* f.home.durable).toEqual(state);
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(bytes);
      expect(yield* f.fs.readFileString(join(f.copy, ".skit-ownership.json"))).toBe(marker);
      expect(yield* recoveryList(f.home.home)).toEqual(recovery);
    }).pipe(Effect.provide(skitLayer)),
  );
}

it.effect("guided setup never asks which managed version should win", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.update;
    const bytes = document("Competing local edits");
    yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), bytes);
    const state = yield* f.home.durable;
    const interaction = yield* makeScriptedInteraction([]);
    yield* f.home.owned(
      setupCommand({
        options: f.options,
        manageOptions: { installOptions: f.home.installOptions },
        interactive: true,
        dryRun: false,
      }).pipe(Effect.provide(interaction.layer)),
    );
    expect(yield* interaction.prompts).toEqual([]);
    expect(yield* f.home.durable).toEqual(state);
    expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(bytes);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("installed edits left alone by setup can still be imported by the update owner", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const edited = document("User's installed edit");
    yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), edited);
    yield* f.apply;
    const state = yield* f.home.durable;
    const skillId = state.installed_skills.find((copy) => copy.path === f.copy)!.skill_id;
    yield* f.home.owned(
      Effect.gen(function* () {
        const library = yield* Library.Service;
        const edit = yield* library.edit(skillId, f.copy);
        yield* edit.apply();
      }),
    );
    expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(edited);
    expect(yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md"))).toBe(edited);
    expect(
      (yield* f.home.durable).imports.some((sourceImport) => sourceImport.kind === "edit"),
    ).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "managing another copy of a Library skill does not repair an already-managed sibling",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const other = join(f.claude, "review");
      const state = yield* f.home.durable;
      yield* f.home.writeDurable({
        ...state,
        installed_skills: state.installed_skills.filter((copy) => copy.path !== other),
      });
      yield* f.fs.remove(join(other, ".skit-ownership.json"));
      const markerPath = join(f.copy, ".skit-ownership.json");
      const marker = JSON.parse(yield* f.fs.readFileString(markerPath));
      const changedMarker = JSON.stringify({
        ...marker,
        expected_hash: `sha256:${"f".repeat(64)}`,
      });
      yield* f.fs.writeFileString(markerPath, changedMarker);
      const scan = yield* f.observe;
      const input = {
        options: f.options,
        manageOptions: { installOptions: f.home.installOptions },
        planId: scan.onboarding.planId,
        selection: { sourceIds: [], copyPaths: [other], removePaths: [] },
      };
      const interaction = yield* makeScriptedInteraction([]);
      const prepared = yield* f.home.owned(
        prepareSetupCommand(input).pipe(Effect.provide(interaction.layer)),
      );
      yield* f.home.owned(
        setupApplyCommand({ ...input, reviewedPlanId: prepared.plan.reviewId }).pipe(
          Effect.provide(interaction.layer),
        ),
      );
      expect(yield* f.fs.readFileString(markerPath)).toBe(changedMarker);
      expect(yield* f.fs.exists(join(other, ".skit-ownership.json"))).toBe(true);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "setup JSON points managed changes to update without offering setup version choices",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.update;
      const result = yield* invoke([
        "skit",
        "setup",
        "--json",
        "--home",
        f.home.home,
        "--codex-root",
        f.agents,
        "--claude-root",
        f.claude,
      ]);
      if (result.contract !== "setup") return yield* Effect.die("Expected setup scan");
      expect(
        result.data.choices.every((choice) => ["source", "copy", "removal"].includes(choice.kind)),
      ).toBe(true);
      const action = actionFor(result.data.actions, "update");
      expect(action.argv.slice(0, 2)).toEqual(["skit", "update"]);
      expect(action.argv).not.toContain("--work-dir");
      const output = renderBlocks(renderSetup(result.data), { color: false });
      expect(output).toContain("Existing managed copies (left unchanged)");
      expect(output).toContain("Use skit update");
    }).pipe(Effect.provide(skitLayer)),
);

for (const flag of ["--use-retained", "--use-copy", "--reconcile-skill"]) {
  it.effect(`setup rejects removed option ${flag}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* f.home.durable;
      const interaction = yield* makeScriptedInteraction([]);
      yield* runCommandTree(
        skitCommand,
        ["setup", flag, "review", "--home", f.home.home, "--json"],
        "test",
      ).pipe(Effect.provide(interaction.layer));
      expect(yield* interaction.failures).toHaveLength(1);
      expect(yield* interaction.results).toEqual([]);
      expect(yield* f.home.durable).toEqual(before);
    }).pipe(Effect.provide(skitLayer)),
  );
}

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
        JSON.stringify({ ...marker, expected_hash: yield* deterministicTreeHash(f.copy) }),
      );
      const newCopy = join(f.agents, "another");
      yield* f.fs.makeDirectory(newCopy);
      yield* f.fs.writeFileString(
        join(newCopy, "SKILL.md"),
        document("New selected Skill").replace("name: review", "name: another"),
      );
      const scan = yield* f.observe;
      expect(scan.changes?.find((fact) => fact.path === f.copy)?.status).toBe("protected");
      const before = (yield* f.home.durable).installed_skills.find((item) => item.path === f.copy);
      const input = {
        options: f.options,
        manageOptions: { installOptions: f.home.installOptions },
        planId: scan.onboarding.planId,
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
      // The selection names one copy; the unrelated one is neither rewritten nor re-recorded.
      const after = (yield* f.home.durable).installed_skills.find((item) => item.path === f.copy);
      expect(after).toEqual(before);
      expect(yield* f.fs.exists(join(newCopy, ".skit-ownership.json"))).toBe(true);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("a changed marker cannot redefine the Library baseline", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* f.observe;
    const markerPath = join(f.copy, ".skit-ownership.json");
    const marker = JSON.parse(yield* f.fs.readFileString(markerPath));
    yield* f.fs.writeFileString(
      markerPath,
      JSON.stringify({ ...marker, expected_hash: `sha256:${"f".repeat(64)}` }),
    );
    const scan = yield* f.observe;
    // The Library's record stays the baseline: SKIT's own bytes only get their marker put right.
    const fact = scan.changes?.find((item) => item.path === f.copy);
    const recorded = before.changes?.find((item) => item.path === f.copy);
    expect(fact?.status).toBe("unchanged");
    expect(fact?.metadataChanged).toBe(true);
    expect(fact?.baselineHash).toBe(recorded?.baselineHash);
    expect(fact?.desiredHash).toBe(recorded?.baselineHash);
    expect(scan.onboarding.planId).not.toBe(before.onboarding.planId);
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
      // A link to SKIT's own bytes reads as its copy, but nothing is ever written through it.
      expect((yield* f.observe).changes?.find((item) => item.path === f.copy)?.status).toBe(
        "unchanged",
      );
      expect(yield* f.fs.readFileString(join(saved, "SKILL.md"))).toBe(bytes);
      expect(yield* f.fs.readLink(f.copy)).toBe(saved);
      yield* f.update;
      yield* f.apply;
      expect(yield* f.fs.readFileString(join(saved, "SKILL.md"))).toBe(bytes);
      expect(yield* f.fs.readLink(f.copy)).toBe(saved);
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(
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
        manageOptions: { installOptions: f.home.installOptions },
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

it.effect("setup reports a missing enabled copy without installing it", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    // The Library wants this copy, but has never installed it here.
    yield* f.fs.remove(f.copy, { recursive: true });
    const state = yield* f.home.durable;
    yield* f.home.writeDurable({
      ...state,
      installed_skills: state.installed_skills.filter((copy) => copy.path !== f.copy),
    });

    const scan = yield* f.observe;
    const install = scan.changes?.find((fact) => fact.path === f.copy);
    expect(install?.status).toBe("install");
    expect(install?.installedSkillId).toBeUndefined();
    expect(install?.destination).toBe("agents");
    // A copy not yet installed is reviewed the same way on every scan.
    expect((yield* f.observe).onboarding.planId).toBe(scan.onboarding.planId);

    const applied = yield* f.apply;
    expect(applied).not.toHaveProperty("changes");
    expect(applied.operationId).toBeUndefined();
    expect(yield* f.fs.exists(join(f.copy, "SKILL.md"))).toBe(false);
    expect((yield* f.home.durable).installed_skills.some((copy) => copy.path === f.copy)).toBe(
      false,
    );
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
        const scan = yield* f.observe;
        const fact = scan.changes?.find((item) => item.path === f.copy);
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
        expect(yield* f.home.durable).toEqual(before);
        expect(yield* f.fs.readFileString(join(f.home.home, "state.json"))).toBe(stateBytes);
        expect(yield* f.fs.readFileString(join(f.home.home, "machine.json"))).toBe(settingsBytes);
        expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toBe(installed);
        expect((yield* f.observe).onboarding.planId).toBe(scan.onboarding.planId);
      }).pipe(Effect.provide(skitLayer)),
  );
}
