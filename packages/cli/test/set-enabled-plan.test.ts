import { SkitConfiguration } from "@smolai/skit-core";
import { assert, it } from "@effect/vitest";
import { systemError } from "effect/PlatformError";
import {
  Cause,
  Clock,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Stream,
} from "effect";
import { join } from "node:path";
import {
  deterministicTreeHash,
  inspectOwnershipMarker,
  libraryStateRevision,
  enabledAt,
  enabledSkillIds,
  SkillsDirectoryNotWritable,
} from "@smolai/skit-core";
import { withSandboxDenying } from "./helpers/sandbox.js";
import {
  applySetEnabledPlan,
  SetEnabledIncomplete,
  openSetEnabledSession,
  planSetEnabled,
  type SetEnabledRequest,
} from "./helpers/set-enabled.js";
import {
  openLibrarySession,
  proposeLibraryEnable,
  proposeLibraryCollectionChange,
  confirmLibraryChange,
} from "@smolai/skit-core/library/session";
import { type ListingBudget, type UsageReport } from "@smolai/skit-core";
import { presentDoctorCleanup } from "../src/library/workflows/doctor-cleanup.js";
import {
  suggestDoctorCleanup,
  openDoctorCleanupSelection,
} from "../src/library/application/doctor-cleanup.js";
import { usageStory } from "../src/storybook/usage-stories.js";
import { presentSetEnabled } from "../src/library/enable/command.js";
import { libraryCommandConfiguration } from "../src/commands/library-configuration.js";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { Prompter, PromptCancelled } from "../src/presentation/prompter.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { testPlatformLayer } from "./helpers/platform.js";
import {
  initializeLibraryMachine,
  libraryHome,
  importCollectionIn,
  writingTo,
} from "./helpers/library-home.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-binding-plan-" });
  const destination = join(root, "account", ".agents", "skills");
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: join(root, "account"),
    roots: { codex: [destination] },
  });
  yield* initializeLibraryMachine(home.home);
  const source = join(root, "source");
  const skills = yield* Effect.forEach(["alpha", "beta"], (name) =>
    Effect.gen(function* () {
      const path = join(source, name);
      yield* fs.makeDirectory(path, { recursive: true });
      yield* fs.writeFileString(join(path, "SKILL.md"), `# ${name}\n`);
      return {
        name,
        sourcePath: path,
        relativePath: name,
        currentHash: yield* deterministicTreeHash(path),
      };
    }),
  );
  yield* home.owned(
    writingTo(
      home.home,
      importCollectionIn(home.home)({
        source: { type: "local", path: source },
        input: source,
        importedAt: "2026-10-16T00:00:00.000Z",
        skills,
        lockFileEntries: [],
      }),
    ),
  );
  const collection = (yield* home.durable).collections[0];
  assert.ok(collection);
  const request: SetEnabledRequest = {
    query: collection.collection_id,
    selectedSkills: ["alpha"],
    scope: { kind: "global" },
    enabled: true,
  };
  return { fs, root, home, destination, request };
});

it.effect("global enablement changes the device choice without changing account bindings", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.flatMap(f.home.durable, (state) =>
      f.home.writeDurable({
        ...state,
        enabled: [{ skill: state.skills.find((skill) => skill.name === "beta")!.skill_id }],
        device_skill_selection: {
          mode: "choose",
          enabled: [],
        },
      }),
    );
    const account = (yield* f.home.durable).enabled;
    const plan = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
    yield* f.home.owned(applySetEnabledPlan(plan));
    const after = yield* f.home.durable;
    assert.deepStrictEqual(after.enabled, account);
    assert.strictEqual(after.device_skill_selection?.mode, "choose");
    assert.isTrue(yield* f.fs.exists(join(f.destination, "alpha", "SKILL.md")));
    assert.isFalse(yield* f.fs.exists(join(f.destination, "beta")));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect.each(["follows-collection", "empty"] as const)(
  "batch previews accumulate device choices with $ account bindings exactly as apply does",
  (accountBinding) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const collection = (yield* f.home.durable).collections[0];
      assert.ok(collection);
      yield* Effect.flatMap(f.home.durable, (state) =>
        f.home.writeDurable({
          ...state,
          enabled:
            accountBinding === "follows-collection"
              ? [{ collection: collection.collection_id }]
              : [],
          device_skill_selection: {
            mode: "choose",
            enabled: [],
          },
        }),
      );
      const enabled = yield* f.home.owned(
        planSetEnabled(
          [{ ...f.request, selectedSkills: ["alpha", "beta"] }],
          f.home.installOptions,
        ),
      );
      yield* f.home.owned(applySetEnabledPlan(enabled));
      const account = (yield* f.home.durable).enabled;
      const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const before = yield* f.fs.readFileString(f.home.statePath);
      const plan = yield* f.home.owned(
        selection.planMany(
          ["alpha", "beta"].map((name) => ({
            subject: f.request.query,
            enabled: false,
            members: [name],
            where: [{ kind: "global" }],
          })),
          f.home.installOptions,
        ),
      );
      assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
      assert.strictEqual(plan.changes[0]?.enabled.length, 1);
      assert.strictEqual(plan.changes[1]?.enabled.length, 0);
      const outcomes = yield* f.home.owned(applySetEnabledPlan(plan));
      assert.deepStrictEqual(outcomes[0]?.value.enabled, plan.changes[0]?.enabled);
      assert.deepStrictEqual(outcomes[1]?.value.enabled, []);
      const after = yield* f.home.durable;
      assert.deepStrictEqual(after.enabled, accountBinding === "follows-collection" ? account : []);
      assert.deepStrictEqual(after.device_skill_selection, {
        mode: "choose",
        enabled: [],
      });
      assert.isFalse(yield* f.fs.exists(join(f.destination, "alpha")));
      assert.isFalse(yield* f.fs.exists(join(f.destination, "beta")));
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("retrying an already selected device Skill still checks unmanaged copies", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.flatMap(f.home.durable, (state) =>
      f.home.writeDurable({
        ...state,
        device_skill_selection: {
          mode: "choose",
          enabled: [{ skill: state.skills.find((skill) => skill.name === "alpha")!.skill_id }],
        },
      }),
    );
    const native = join(f.home.inventory.home, ".codex", "skills", "alpha");
    yield* f.fs.makeDirectory(native, { recursive: true });
    yield* f.fs.writeFileString(join(native, "SKILL.md"), "native copy\n");
    const plan = yield* f.home.owned(
      planSetEnabled([f.request], { ...f.home.installOptions, overrides: {} }),
    );
    const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "InstalledSkillWouldDuplicate");
    assert.strictEqual(yield* f.fs.readFileString(join(native, "SKILL.md")), "native copy\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("preparing a Binding plan changes neither Library metadata nor native copies", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* f.fs.readFileString(f.home.statePath);
    const plan = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
    assert.deepStrictEqual(plan.changes[0]?.skills, ["alpha"]);
    assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("applying a plan uses its captured selection and routing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const selectedSkills = ["alpha"];
    const routes = [f.destination];
    const configuration = { ...f.home.installOptions, overrides: { codex: routes } };
    const plan = yield* f.home.owned(
      planSetEnabled([{ ...f.request, selectedSkills }], configuration),
    );
    selectedSkills.splice(0, 1, "beta");
    const redirected = join(f.root, "redirected");
    routes.splice(0, 1, redirected);
    yield* f.home.owned(applySetEnabledPlan(plan));
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.destination, "alpha", "SKILL.md")),
      "# alpha\n",
    );
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "beta")), false);
    assert.strictEqual(yield* f.fs.exists(redirected), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("refuses a plan when the Library changed during interactive selection", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
    yield* Effect.flatMap(f.home.durable, (state) =>
      f.home.writeDurable({ ...state, ownershipIssues: [] }),
    );
    const plan = yield* f.home.owned(
      selection.plan(
        {
          subject: f.request.query,
          members: ["alpha"],
          enabled: true,
          where: [{ kind: "global" }],
        },
        f.home.installOptions,
      ),
    );
    const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.StalePlan");
    assert.deepStrictEqual((yield* f.home.durable).enabled, []);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("rechecks duplicates created after preview before saving Binding intent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* f.home.owned(
      planSetEnabled([f.request], { ...f.home.installOptions, overrides: {} }),
    );
    const nativeCopy = join(f.home.inventory.home, ".codex", "skills", "alpha");
    yield* f.fs.makeDirectory(nativeCopy, { recursive: true });
    yield* f.fs.writeFileString(join(nativeCopy, "SKILL.md"), "native copy\n");
    const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "InstalledSkillWouldDuplicate");
    assert.deepStrictEqual((yield* f.home.durable).enabled, []);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
    assert.strictEqual(yield* f.fs.readFileString(join(nativeCopy, "SKILL.md")), "native copy\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("an unwritable root refuses enablement before saving Binding intent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* f.home.owned(
      planSetEnabled([f.request], f.home.installOptions).pipe(
        withSandboxDenying(join(f.root, "account", ".agents")),
      ),
    );
    const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
    assert.instanceOf(error, SkillsDirectoryNotWritable);
    assert.strictEqual(error.root, f.destination);
    assert.deepStrictEqual((yield* f.home.durable).enabled, []);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("refuses to apply a prepared plan to another Library", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
    const other = yield* libraryHome({ home: join(f.root, "other-library") });
    const error = yield* other.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.StalePlan");
    assert.deepStrictEqual((yield* other.durable).enabled, []);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("derives placements and filters multi-Scope disable intent to enabled members", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const repository = join(f.root, "repository");
    yield* f.fs.makeDirectory(repository);
    for (const [members, where] of [
      [["alpha"], [{ kind: "global" }]],
      [["beta"], [{ kind: "repository", root: repository }]],
    ] as const) {
      const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const plan = yield* f.home.owned(
        selection.plan(
          { subject: f.request.query, members, where, enabled: true },
          f.home.installOptions,
        ),
      );
      yield* f.home.owned(applySetEnabledPlan(plan));
    }
    const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
    assert.deepStrictEqual(
      selection.view.placements.map((placement) => [
        placement.scope.kind,
        placement.skillIds.map(
          (id) => selection.view.collections[0]?.members.find((member) => member.id === id)?.name,
        ),
      ]),
      [
        ["global", ["alpha"]],
        ["repository", ["beta"]],
      ],
    );
    const before = yield* f.fs.readFileString(f.home.statePath);
    const both = yield* f.home.owned(
      selection.plan(
        {
          subject: f.request.query,
          enabled: false,
          members: ["alpha", "beta"],
          where: "where-enabled",
        },
        f.home.installOptions,
      ),
    );
    assert.deepStrictEqual(
      both.changes.map((change) => [change.scope.kind, change.skills]),
      [
        ["global", ["alpha"]],
        ["repository", ["beta"]],
      ],
    );
    const onlyAlpha = yield* f.home.owned(
      selection.plan(
        {
          subject: f.request.query,
          enabled: false,
          members: ["alpha"],
          where: "where-enabled",
        },
        f.home.installOptions,
      ),
    );
    assert.strictEqual(onlyAlpha.changes.length, 1);
    assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
    yield* f.home.owned(applySetEnabledPlan(onlyAlpha));
    const settled = yield* f.home.durable;
    const beta = selection.view.collections[0]?.members.find((member) => member.name === "beta");
    assert.ok(beta);
    assert.deepStrictEqual(settled.enabled, []);
    assert.deepStrictEqual(settled.repositories[0]?.enabled, [{ skill: beta.id }]);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a TUI proposal keeps the revision displayed before the proposal was made", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const displayed = yield* f.home.owned(
      Effect.flatMap(SkitConfiguration, (paths) =>
        openLibrarySession(paths.skitHome, f.home.installOptions),
      ),
    );
    yield* Effect.flatMap(f.home.durable, (state) =>
      f.home.writeDurable({ ...state, ownershipIssues: [] }),
    );
    const before = yield* f.fs.readFileString(f.home.statePath);
    const proposed = yield* f.home.owned(
      proposeLibraryCollectionChange(displayed, f.home.installOptions, f.request.query, true, [
        { kind: "global" },
      ]),
    );
    assert.strictEqual(proposed.outcome.kind, "preview");
    const confirmed = yield* f.home.owned(confirmLibraryChange(proposed));
    assert.strictEqual(confirmed.outcome?.kind, "failed");
    if (confirmed.outcome?.kind === "failed")
      assert.strictEqual(confirmed.outcome.failure.code, "CONFLICT");
    assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("batch previews accumulate same-scope disables without restoring earlier members", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.home.owned(
      planSetEnabled([{ ...f.request, selectedSkills: ["alpha", "beta"] }], f.home.installOptions),
    );
    yield* f.home.owned(applySetEnabledPlan(enabled));
    const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
    const before = yield* f.fs.readFileString(f.home.statePath);
    const plan = yield* f.home.owned(
      selection.planMany(
        ["alpha", "beta"].map((name) => ({
          subject: f.request.query,
          enabled: false,
          members: [name],
          where: [{ kind: "global" }],
        })),
        f.home.installOptions,
      ),
    );
    assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
    assert.strictEqual(plan.changes[0]?.enabled.length, 1);
    assert.strictEqual(plan.changes[1]?.enabled.length, 0);
    yield* f.home.owned(applySetEnabledPlan(plan));
    assert.deepStrictEqual((yield* f.home.durable).enabled, []);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "beta")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

const cleanupFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const enabled = yield* f.home.owned(
    planSetEnabled([{ ...f.request, selectedSkills: ["alpha", "beta"] }], f.home.installOptions),
  );
  yield* f.home.owned(applySetEnabledPlan(enabled));
  const budget: Extract<ListingBudget, { _tag: "Estimated" }> = {
    _tag: "Estimated",
    harness: "codex",
    cwd: f.root,
    model: "test",
    unit: "budget-tokens",
    demand: 1600,
    limit: 1000,
    fitted: 1000,
    shortened: 0,
    omitted: 0,
    descriptionsDropped: { min: 0, max: 0 },
    fidelity: "modelled",
    collections: [],
    basis: "test",
    coverage: [],
    entries: [
      { name: "alpha", path: join(f.destination, "alpha", "SKILL.md"), demand: 700 },
      { name: "beta", path: join(f.destination, "beta", "SKILL.md"), demand: 400 },
      { name: "unmanaged", path: join(f.root, "unmanaged", "SKILL.md"), demand: 500 },
    ],
  };
  const usage: UsageReport = {
    ...usageStory,
    rows: [],
    incomplete: false,
    coverage: usageStory.coverage.map((c) => ({ ...c, unsupported: 0 })),
  };
  return { ...f, budget, usage, state: yield* f.home.durable };
});

it.effect(
  "doctor ranks exact managed unused skills and selects only enough to cover the excess",
  () =>
    Effect.gen(function* () {
      const f = yield* cleanupFixture;
      const suggest = (usage = f.usage) =>
        suggestDoctorCleanup(f.state, [f.budget], usage, f.home.installOptions);
      assert.deepStrictEqual(
        suggest().map((c) => [c.name, c.selected]),
        [
          ["alpha", true],
          ["beta", false],
        ],
      );
      // A name-only observation in another harness protects the skill across all projects.
      const used = { ...f.usage, rows: [{ ...usageStory.rows[1]!, name: "alpha" }] };
      assert.deepStrictEqual(
        suggest(used).map((c) => c.name),
        ["beta"],
      );
      // Read-only evidence protects a managed skill even if it contributed no activation count.
      const read = {
        ...f.usage,
        rows: [
          {
            ...usageStory.rows[0]!,
            name: "old-name",
            skillId: f.state.skills.find((s) => s.name === "alpha")!.skill_id,
            uses: 0,
            loads: 0,
            reads: 1,
          },
        ],
      };
      assert.deepStrictEqual(
        suggest(read).map((c) => c.name),
        ["beta"],
      );
      const partial = {
        ...f.usage,
        incomplete: true,
        coverage: [
          ...f.usage.coverage.map((root) => ({ ...root, unsupported: 3, changedFiles: 1 })),
          ...f.usage.coverage.map((root) => ({
            ...root,
            root: "/missing/archive",
            status: "missing" as const,
            windowRecords: 0,
          })),
        ],
      };
      assert.deepStrictEqual(
        suggest(partial).map((candidate) => [candidate.name, candidate.selected]),
        [
          ["alpha", true],
          ["beta", false],
        ],
      );
      for (const usage of [
        { ...f.usage, coverage: [] },
        {
          ...f.usage,
          coverage: f.usage.coverage.map((c) => ({ ...c, status: "missing" as const })),
        },
        { ...f.usage, coverage: f.usage.coverage.map((c) => ({ ...c, windowRecords: 0 })) },
      ])
        assert.ok(suggest(usage).every((c) => !c.hasUsageHistory && !c.selected));
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("cleanup reads one captured Library and protects a Skill used in a real transcript", () =>
  Effect.gen(function* () {
    const f = yield* cleanupFixture;
    const sessions = join(f.root, "cleanup-codex", "sessions");
    const transcript = join(sessions, "record.jsonl");
    const at = new Date((yield* Clock.currentTimeMillis) - 1).toISOString();
    yield* f.fs.makeDirectory(sessions, { recursive: true });
    yield* f.fs.writeFileString(
      transcript,
      [
        { type: "session_meta", timestamp: at, payload: { id: "cleanup", cwd: f.root } },
        {
          type: "response_item",
          timestamp: at,
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "read-beta",
            arguments: JSON.stringify({ cmd: `cat ${join(f.destination, "beta", "SKILL.md")}` }),
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    let loads = 0;
    let capturedReads: number | undefined;
    const observed = {
      ...f.fs,
      stream: (path: string, options?: Parameters<typeof f.fs.stream>[1]) =>
        Stream.unwrap(
          Effect.sync(() => {
            if (path === transcript) {
              assert.strictEqual(capturedReads, undefined);
              capturedReads = loads;
              assert.isAbove(capturedReads, 0);
            }
            return f.fs.stream(path, options);
          }),
        ),
      readFileString: (...args: Parameters<typeof f.fs.readFileString>) =>
        Effect.suspend(() => {
          if (args[0] === f.home.statePath) loads++;
          return f.fs.readFileString(...args);
        }),
    };
    const selection = yield* openDoctorCleanupSelection(
      [f.budget],
      f.home.installOptions,
      14,
      () => Effect.void,
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CODEX_HOME: join(f.root, "cleanup-codex"),
            CLAUDE_CONFIG_DIR: join(f.root, "cleanup-claude"),
          }),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, observed),
      (effect) => f.home.owned(effect),
    );
    assert.strictEqual(loads, capturedReads);
    assert.deepStrictEqual(
      selection.candidates.map((candidate) => candidate.name),
      ["alpha"],
    );
    assert.strictEqual(
      Date.parse(selection.usage.window.end) - Date.parse(selection.usage.window.start),
      14 * 86400000,
    );
    assert.ok(selection.usage.rows.some((row) => row.name === "beta" && row.reads === 1));
    const plan = yield* selection.preview(selection.candidates.map((c) => c.id));
    assert.strictEqual(loads, capturedReads);
    assert.strictEqual(plan.changes.length, 1);
    yield* f.home.owned(applySetEnabledPlan(plan));
    const after = yield* f.home.durable;
    const beta = after.skills.find((skill) => skill.name === "beta");
    assert.ok(beta);
    assert.deepStrictEqual(after.enabled, [{ skill: beta.skill_id }]);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

for (const mode of ["dry-run", "decline", "apply", "cancel"] as const) {
  it.effect(`interactive doctor ${mode} preserves review/apply boundaries`, () =>
    Effect.gen(function* () {
      const f = yield* cleanupFixture;
      if (mode === "dry-run") {
        const sessions = join(f.root, "empty-codex", "sessions");
        yield* f.fs.makeDirectory(sessions, { recursive: true });
        yield* f.fs.writeFileString(
          join(sessions, "partial.jsonl"),
          JSON.stringify({
            type: "session_meta",
            timestamp: new Date((yield* Clock.currentTimeMillis) - 1).toISOString(),
            payload: { id: "partial-scan", cwd: f.root },
          }) + "\n{malformed}\n",
        );
      }
      const before = yield* f.fs.readFileString(f.home.statePath);
      const notes: string[] = [];
      let confirmations = 0;
      const cancelled = new PromptCancelled({ prompt: "test", reason: "back" });
      const prompt = Layer.succeed(
        Prompter,
        Prompter.of({
          select: () => Effect.fail(cancelled),
          autocomplete: () => Effect.fail(cancelled),
          text: () => Effect.fail(cancelled),
          password: () => Effect.fail(cancelled),
          multiselect: (_message, choices) => {
            assert.ok(choices.every((choice) => !choice.hint?.includes("uncertain")));
            if (mode === "dry-run")
              assert.strictEqual(
                choices.find((choice) => choice.label.startsWith("alpha"))?.selected,
                true,
              );
            return mode === "cancel"
              ? Effect.fail(cancelled)
              : Effect.succeed(
                  choices.filter((c) => c.label.startsWith("alpha")).map((c) => c.value),
                );
          },
          confirm: () =>
            Effect.sync(() => {
              confirmations++;
              return mode === "apply";
            }),
        }),
      );
      const changed = yield* f.home.owned(
        presentDoctorCleanup([f.budget], f.home.installOptions, 30, mode === "dry-run").pipe(
          Effect.catchTag("PromptCancelled", () => Effect.succeed(false)),
          Effect.provide(prompt),
          Effect.provide(
            rendererTestLayer({
              note: (body) =>
                Effect.sync(() => {
                  notes.push(body);
                }),
            }),
          ),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                CODEX_HOME: join(f.root, "empty-codex"),
                CLAUDE_CONFIG_DIR: join(f.root, "empty-claude"),
              }),
            ),
          ),
        ),
      );
      if (mode === "dry-run") {
        assert.ok(
          notes.every((note) => !note.includes("No transcript history in this window for codex")),
        );
      }
      assert.strictEqual(changed, mode === "apply");
      assert.strictEqual(confirmations, mode === "dry-run" || mode === "cancel" ? 0 : 1);
      if (mode !== "apply")
        assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
      else {
        assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
        assert.strictEqual(yield* f.fs.exists(join(f.destination, "beta")), true);
        assert.strictEqual((yield* f.home.durable).skills.length, 2);
      }
      if (mode !== "cancel") assert.ok(notes.some((note) => note.includes("~900 / 1,000 tokens")));
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );
}

it.effect(
  "doctor maps the listed repository copy to its own scope without suggesting the global copy",
  () =>
    Effect.gen(function* () {
      const f = yield* cleanupFixture;
      const scope = { kind: "repository" as const, root: join(f.root, "repo") };
      const enable = yield* f.home.owned(
        planSetEnabled([{ ...f.request, scope }], f.home.installOptions),
      );
      yield* f.home.owned(applySetEnabledPlan(enable));
      const state = yield* f.home.durable;
      const local = state.installed_skills.find(
        (p) =>
          p.path !== join(f.destination, "alpha") &&
          p.skill_id === state.skills.find((s) => s.name === "alpha")?.skill_id,
      );
      assert.ok(local);
      const candidates = suggestDoctorCleanup(
        state,
        [
          {
            ...f.budget,
            entries: [{ name: "alpha", path: join(local.path, "SKILL.md"), demand: 700 }],
          },
        ],
        f.usage,
        f.home.installOptions,
      );
      assert.strictEqual(candidates.length, 1);
      assert.deepStrictEqual(candidates[0]?.scope, scope);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "doctor batch disables across collections preserve other members at the shared scope",
  () =>
    Effect.gen(function* () {
      const f = yield* cleanupFixture;
      const source = join(f.root, "another-source");
      yield* f.fs.makeDirectory(source);
      yield* f.fs.writeFileString(join(source, "SKILL.md"), "# gamma\n");
      yield* f.home.owned(
        writingTo(
          f.home.home,
          importCollectionIn(f.home.home)({
            source: { type: "local", path: source },
            input: source,
            importedAt: "2026-10-18T00:00:00.000Z",
            lockFileEntries: [],
            skills: [
              {
                name: "gamma",
                sourcePath: source,
                relativePath: ".",
                currentHash: yield* deterministicTreeHash(source),
              },
            ],
          }),
        ),
      );
      const gamma = (yield* f.home.durable).skills.find((s) => s.name === "gamma");
      assert.ok(gamma);
      const enabled = yield* f.home.owned(
        planSetEnabled(
          [{ ...f.request, query: gamma.collection_id, selectedSkills: ["gamma"] }],
          f.home.installOptions,
        ),
      );
      yield* f.home.owned(applySetEnabledPlan(enabled));
      const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const plan = yield* f.home.owned(
        selection.planMany(
          [
            {
              subject: f.request.query,
              members: ["alpha"],
              enabled: false,
              where: [{ kind: "global" }],
            },
            {
              subject: gamma.collection_id,
              members: ["gamma"],
              enabled: false,
              where: [{ kind: "global" }],
            },
          ],
          f.home.installOptions,
        ),
      );
      const beta = (yield* f.home.durable).skills.find((s) => s.name === "beta");
      assert.ok(beta);
      assert.deepStrictEqual(plan.changes[1]?.enabled, [{ skill: beta.skill_id }]);
      yield* f.home.owned(applySetEnabledPlan(plan));
      assert.deepStrictEqual((yield* f.home.durable).enabled, [{ skill: beta.skill_id }]);
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "gamma")), false);
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "beta")), true);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// `skit add ~/.claude/skills/x` then `skit enable x` is how an agent improvises setup: the
// destination already holds the user's own copy of the skill.
it.effect(
  "enabling manages an unmanaged copy that already holds the bytes SKIT would install",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.makeDirectory(join(f.destination, "alpha"), { recursive: true });
      yield* f.fs.writeFileString(join(f.destination, "alpha", "SKILL.md"), "# alpha\n");
      const plan = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));

      const [outcome] = yield* f.home.owned(applySetEnabledPlan(plan));

      assert.deepStrictEqual(
        outcome?.kind === "applied" ? outcome.value.installed_skills.map((p) => p.status) : [],
        ["installed"],
      );
      assert.strictEqual(
        (yield* inspectOwnershipMarker(join(f.destination, "alpha"))).kind,
        "valid",
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "enabling never manages a git checkout, even one holding the bytes SKIT would install",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const checkout = join(f.destination, "alpha");
      yield* f.fs.makeDirectory(join(checkout, ".git"), { recursive: true });
      yield* f.fs.writeFileString(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
      yield* f.fs.writeFileString(join(checkout, "SKILL.md"), "# alpha\n");
      const plan = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));

      const failure = yield* Effect.flip(f.home.owned(applySetEnabledPlan(plan)));
      assert.instanceOf(failure, SetEnabledIncomplete);

      // A checkout is someone else's: SKIT neither writes into it nor records it.
      assert.deepStrictEqual(failure.results[0]?.installed_skills, []);
      assert.strictEqual((yield* inspectOwnershipMarker(checkout)).kind, "absent");
      assert.strictEqual(yield* f.fs.exists(join(checkout, ".git", "HEAD")), true);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a different copy at the destination is reported, and disabling leaves it in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const theirs = join(f.destination, "alpha", "SKILL.md");
    yield* f.fs.makeDirectory(join(f.destination, "alpha"), { recursive: true });
    yield* f.fs.writeFileString(theirs, "# alpha, edited by hand\n");
    const enable = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
    // The preview names the folder, so a dry run does not promise a clean enable.
    assert.deepStrictEqual(
      enable.changes[0]?.unmanaged_destinations?.map((folder) => folder.path),
      [join(f.destination, "alpha")],
    );

    const failure = yield* Effect.flip(f.home.owned(applySetEnabledPlan(enable)));
    assert.instanceOf(failure, SetEnabledIncomplete);

    assert.deepStrictEqual(
      failure.results[0]?.installed_skills.map((p) => p.status),
      ["conflicted"],
    );
    const disable = yield* f.home.owned(
      planSetEnabled([{ ...f.request, enabled: false }], f.home.installOptions),
    );
    yield* f.home.owned(applySetEnabledPlan(disable));
    assert.strictEqual(yield* f.fs.readFileString(theirs), "# alpha, edited by hand\n");
    assert.deepStrictEqual((yield* f.home.durable).installed_skills, []);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("allow-duplicate refuses to replace the user's link at the destination", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const elsewhere = join(f.root, "dotfiles", "alpha");
    yield* f.fs.makeDirectory(elsewhere, { recursive: true });
    yield* f.fs.writeFileString(join(elsewhere, "SKILL.md"), "# alpha\n");
    yield* f.fs.makeDirectory(f.destination, { recursive: true });
    yield* f.fs.symlink(elsewhere, join(f.destination, "alpha"));
    const plan = yield* f.home.owned(
      planSetEnabled([{ ...f.request, allowDuplicate: true }], f.home.installOptions),
    );

    const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);

    assert.strictEqual(error._tag, "InstalledSkillWouldReplaceLink");
    assert.deepStrictEqual((yield* f.home.durable).enabled, []);
    assert.strictEqual(yield* f.fs.readLink(join(f.destination, "alpha")), elsewhere);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("enable leaves repository-owned identical copies unmanaged, including worktrees", () =>
  Effect.gen(function* () {
    for (const gitEntry of ["directory", "file"] as const) {
      const f = yield* fixture;
      const repository = join(f.root, "account");
      yield* f.fs.makeDirectory(repository, { recursive: true });
      if (gitEntry === "directory") yield* f.fs.makeDirectory(join(repository, ".git"));
      else yield* f.fs.writeFileString(join(repository, ".git"), "gitdir: /elsewhere/worktree\n");
      const skill = join(f.destination, "alpha");
      yield* f.fs.makeDirectory(skill, { recursive: true });
      yield* f.fs.writeFileString(join(skill, "SKILL.md"), "# alpha\n");
      const enable = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
      const failure = yield* Effect.flip(f.home.owned(applySetEnabledPlan(enable)));
      assert.instanceOf(failure, SetEnabledIncomplete);
      assert.deepStrictEqual(
        failure.results[0]?.installed_skills.map((p) => p.status),
        ["conflicted"],
      );
      assert.strictEqual((yield* inspectOwnershipMarker(skill)).kind, "absent");
      const disable = yield* f.home.owned(
        planSetEnabled([{ ...f.request, enabled: false }], f.home.installOptions),
      );
      yield* f.home.owned(applySetEnabledPlan(disable));
      assert.strictEqual(yield* f.fs.readFileString(join(skill, "SKILL.md")), "# alpha\n");
    }
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "saved enablement and the first installed target survive a later target failure, then retry converges",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const claude = join(f.root, "claude-skills");
      yield* f.fs.makeDirectory(claude);
      const configuration = {
        ...f.home.installOptions,
        overrides: { ...f.home.installOptions.overrides, "claude-code": [claude] },
      };
      const plan = yield* f.home.owned(
        planSetEnabled([f.request], configuration).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              to === join(claude, "alpha")
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
      );
      const failed = yield* Effect.flip(f.home.owned(applySetEnabledPlan(plan)));
      assert.instanceOf(failed, SetEnabledIncomplete);
      assert.strictEqual(failed.code, "OPERATION_FAILED");
      const state = yield* f.home.durable;
      const enabled = enabledAt(state, { kind: "global" });
      assert.ok(enabled);
      assert.strictEqual(enabledSkillIds(state, enabled.enabled).length, 1);
      assert.strictEqual(failed.results[0]?.application.intent, "saved");
      assert.strictEqual(failed.results[0]?.application.status, "incomplete");
      assert.strictEqual(failed.results[0]?.application.revision, libraryStateRevision(state));
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.destination, "alpha", "SKILL.md")),
        "# alpha\n",
      );
      assert.strictEqual(yield* f.fs.exists(join(claude, "alpha")), false);
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "beta")), false);
      const retry = yield* f.home.owned(planSetEnabled([f.request], configuration));
      const [completed] = yield* f.home.owned(applySetEnabledPlan(retry));
      assert.strictEqual(completed.value.application.intent, "unchanged");
      assert.strictEqual(completed.value.application.status, "complete");
      assert.deepStrictEqual(
        completed.value.installed_skills.map((installedSkill) => installedSkill.status),
        ["installed", "installed"],
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(claude, "alpha", "SKILL.md")),
        "# alpha\n",
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a refused intent save remains a refusal and creates no installed copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const refused = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: f.home.statePath,
    });
    const plan = yield* f.home.owned(
      planSetEnabled([f.request], f.home.installOptions).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            to === f.home.statePath ? Effect.fail(refused) : f.fs.rename(from, to),
        }),
      ),
    );
    const before = yield* f.home.durable;
    const failed = yield* Effect.flip(f.home.owned(applySetEnabledPlan(plan)));
    assert.strictEqual(failed, refused);
    assert.deepStrictEqual(yield* f.home.durable, before);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a disable refuses an edited active copy before saving anything", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enable = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
    yield* f.home.owned(applySetEnabledPlan(enable));
    const path = join(f.destination, "alpha", "SKILL.md");
    yield* f.fs.writeFileString(path, "Independent user edits\n");
    const before = yield* f.home.durable;
    const disable = yield* f.home.owned(
      planSetEnabled([{ ...f.request, enabled: false }], f.home.installOptions),
    );
    const failed = yield* Effect.flip(f.home.owned(applySetEnabledPlan(disable)));
    assert.strictEqual(failed._tag, "UninstallConflict");
    assert.deepStrictEqual(yield* f.home.durable, before);
    assert.strictEqual(yield* f.fs.readFileString(path), "Independent user edits\n");
    assert.strictEqual((yield* inspectOwnershipMarker(join(f.destination, "alpha"))).kind, "valid");
    yield* f.fs.writeFileString(path, "# alpha\n");
    const retry = yield* f.home.owned(
      planSetEnabled([{ ...f.request, enabled: false }], f.home.installOptions),
    );
    const [completed] = yield* f.home.owned(applySetEnabledPlan(retry));
    assert.strictEqual(completed.value.application.status, "complete");
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "the Library session reports incomplete installation and refreshes the saved desired selection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = join(f.destination, "alpha");
      yield* f.fs.makeDirectory(path, { recursive: true });
      yield* f.fs.writeFileString(join(path, "SKILL.md"), "Foreign copy must remain\n");
      const opened = yield* f.home.owned(
        Effect.flatMap(SkitConfiguration, (paths) =>
          openLibrarySession(paths.skitHome, f.home.installOptions),
        ),
      );
      const row = opened.skills.find((skill) => skill.name === "alpha");
      assert.ok(row);
      const proposed = yield* f.home.owned(
        proposeLibraryEnable(opened, f.home.installOptions, row, { scope: { kind: "global" } }),
      );
      const confirmed = yield* f.home.owned(confirmLibraryChange(proposed));
      assert.strictEqual(confirmed.outcome?.kind, "failed");
      if (confirmed.outcome?.kind === "failed") {
        assert.strictEqual(confirmed.outcome.failure.code, "CONFLICT");
        assert.match(confirmed.outcome.failure.message, /intent was saved/);
      }
      assert.strictEqual(
        confirmed.skills.find((skill) => skill.name === "alpha")?.scopes.length,
        1,
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(path, "SKILL.md")),
        "Foreign copy must remain\n",
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a batch saves every intent together and reports the scope that cannot install", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const repository = join(f.root, "project");
    const target = join(repository, ".agents", "skills", "beta");
    const plan = yield* f.home.owned(
      planSetEnabled(
        [
          f.request,
          {
            ...f.request,
            selectedSkills: ["beta"],
            scope: { kind: "repository", root: repository },
          },
        ],
        f.home.installOptions,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            to === target
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
    );
    const failed = yield* Effect.flip(f.home.owned(applySetEnabledPlan(plan)));
    assert.instanceOf(failed, SetEnabledIncomplete);
    assert.deepStrictEqual(
      failed.results.map((result) => [result.skills, result.application.status]),
      [
        [["alpha"], "complete"],
        [["beta"], "incomplete"],
      ],
    );
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.destination, "alpha", "SKILL.md")),
      "# alpha\n",
    );
    assert.strictEqual(yield* f.fs.exists(target), false);
    const state = yield* f.home.durable;
    assert.strictEqual(state.repositories.length, 1);
    const enabled = enabledAt(state, { kind: "global" });
    assert.ok(enabled);
    assert.strictEqual(enabledSkillIds(state, enabled.enabled).length, 1);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect.each(["defect", "interruption"] as const)(
  "a post-acceptance %s keeps its Effect semantics",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = yield* f.home.owned(
        planSetEnabled([f.request], f.home.installOptions).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              to === join(f.destination, "alpha")
                ? kind === "defect"
                  ? Effect.die("Test install defect")
                  : Effect.interrupt
                : f.fs.rename(from, to),
          }),
        ),
      );
      const exit = yield* Effect.exit(f.home.owned(applySetEnabledPlan(plan)));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(
          kind === "defect" ? Cause.hasDies(exit.cause) : Cause.hasInterrupts(exit.cause),
        );
        assert.isFalse(Cause.hasFails(exit.cause));
      }
      const state = yield* f.home.durable;
      const enabled = enabledAt(state, { kind: "global" });
      assert.ok(enabled);
      assert.strictEqual(enabledSkillIds(state, enabled.enabled).length, 1);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "the parsed CLI reports saved intent, a concrete incomplete result and exit 12 for a foreign destination",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const destination = join(f.destination, "alpha");
      yield* f.fs.makeDirectory(destination, { recursive: true });
      yield* f.fs.writeFileString(join(destination, "SKILL.md"), "Foreign active bytes\n");
      const interaction = yield* makeScriptedInteraction([]);
      yield* runCommandTree(
        skitCommand,
        [
          "enable",
          "alpha",
          "--global",
          "--json",
          "--home",
          f.home.home,
          "--codex-root",
          f.destination,
          "--claude-root",
          join(f.root, "absent-claude"),
          "--opencode-root",
          join(f.root, "absent-opencode"),
        ],
        "test",
      ).pipe(Effect.provide(interaction.layer));
      assert.deepStrictEqual(yield* interaction.failures, []);
      const [result] = yield* interaction.results;
      assert.ok(result);
      assert.strictEqual(result.contract, "enable");
      if (result.contract !== "enable") return;
      assert.strictEqual(result.schema, "skit.enable.v10");
      assert.strictEqual(result.exitCode, 12);
      assert.strictEqual(result.data.application.status, "incomplete");
      assert.strictEqual(result.data.application.intent, "saved");
      assert.strictEqual(
        result.data.application.revision,
        libraryStateRevision(yield* f.home.durable),
      );
      const rendered = renderContract(result, { color: false, detail: "full" });
      assert.match(rendered, /Library choice saved/);
      assert.match(rendered, /Installed copies need attention/);
      assert.notMatch(rendered, /^Enabled/);
      assert.strictEqual(
        yield* f.fs.readFileString(join(destination, "SKILL.md")),
        "Foreign active bytes\n",
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a newly active agent target invalidates the review before any binding is saved", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const claude = join(f.home.inventory.home, ".claude", "skills");
    const configuration = f.home.installOptions;
    const plan = yield* f.home.owned(planSetEnabled([f.request], configuration));
    const before = yield* f.home.durable;
    yield* f.fs.makeDirectory(claude, { recursive: true });
    const error = yield* Effect.flip(f.home.owned(applySetEnabledPlan(plan)));
    assert.strictEqual(error._tag, "Library.StalePlan");
    assert.deepStrictEqual(yield* f.home.durable, before);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
    assert.strictEqual(yield* f.fs.exists(join(claude, "alpha")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "an intervening state change after intent acceptance is not rebased by saving installed skills",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let changed = false;
      const plan = yield* f.home.owned(
        planSetEnabled([f.request], f.home.installOptions).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                yield* f.fs.rename(from, to);
                if (to === f.home.statePath) {
                  const next = JSON.parse(yield* f.fs.readFileString(to));
                  if (changed) {
                    // Recovery/history bookkeeping may advance, but installed rows must not
                    // be published on the foreign state or erase its metadata.
                    assert.deepStrictEqual(next.ownershipIssues, []);
                    assert.deepStrictEqual(next.installed_skills, []);
                  } else if (next.enabled.length > 0) {
                    changed = true;
                    yield* f.fs.writeFileString(
                      to,
                      JSON.stringify({ ...next, ownershipIssues: [] }),
                    );
                  }
                }
              }),
          }),
        ),
      );
      const failed = yield* Effect.flip(f.home.owned(applySetEnabledPlan(plan)));
      assert.instanceOf(failed, SetEnabledIncomplete);
      assert.strictEqual(failed.reason, "update");
      assert.strictEqual(failed.code, "CONFLICT");
      const current = yield* f.home.durable;
      assert.deepStrictEqual(current.ownershipIssues, []);
      assert.deepStrictEqual(current.installed_skills, []);
      assert.strictEqual(failed.results[0]?.application.revision, libraryStateRevision(current));
      assert.strictEqual(failed.results[0]?.application.status, "incomplete");
      const enabled = enabledAt(current, { kind: "global" });
      assert.ok(enabled);
      assert.strictEqual(enabledSkillIds(current, enabled.enabled).length, 1);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("the CLI adapter keeps the I/O failure exit code after saving enablement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const interaction = yield* makeScriptedInteraction([]);
    const configuration = yield* libraryCommandConfiguration({
      home: Option.some(f.home.home),
      codexRoot: Option.some(f.destination),
      claudeRoot: Option.some(join(f.root, "claude")),
      opencodeRoot: Option.some(join(f.root, "opencode")),
      devinRoot: [],
    });
    yield* f.home.owned(
      presentSetEnabled({
        action: "enable",
        enabled: true,
        subject: "alpha",
        scope: { kind: "global" },
        cwd: f.root,
        all: false,
        dryRun: false,
        interactive: false,
        configuration,
      }).pipe(
        Effect.provide(interaction.layer),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            to === join(f.destination, "alpha")
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
    );
    assert.deepStrictEqual(yield* interaction.failures, []);
    const [result] = yield* interaction.results;
    assert.ok(result);
    assert.strictEqual(result.contract, "enable");
    if (result.contract !== "enable") return;
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.data.application.status, "incomplete");
    assert.strictEqual(result.data.application.failure?.code, "OPERATION_FAILED");
    assert.strictEqual(result.data.application.intent, "saved");
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

for (const drift of ["create", "modify", "symlink", "source"] as const)
  it.effect(`Library owner refuses ${drift} drift before accepting intent`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = join(f.destination, "alpha");
      if (drift === "modify" || drift === "symlink") {
        const initial = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
        yield* f.home.owned(applySetEnabledPlan(initial));
      }
      const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const plan = yield* f.home.owned(
        selection.plan(
          {
            subject: f.request.query,
            members: ["alpha"],
            enabled: true,
            where: [{ kind: "global" }],
          },
          f.home.installOptions,
        ),
      );
      assert.ok(plan.owner);
      if (drift === "source") {
        const source = plan.owner.plan.folders.find((e) =>
          e.path.startsWith(f.home.originals + "/"),
        );
        assert.ok(source);
        yield* f.fs.writeFileString(
          join(source.path, "alpha", "SKILL.md"),
          "changed retained bytes\n",
        );
      } else if (drift === "symlink") {
        const outside = join(f.root, "outside");
        yield* f.fs.rename(path, outside);
        yield* f.fs.symlink(outside, path);
      } else {
        yield* f.fs.makeDirectory(path, { recursive: true });
        yield* f.fs.writeFileString(join(path, "SKILL.md"), "changed native bytes\n");
      }
      const before = yield* f.home.durable;
      const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Library.StalePlan");
      assert.deepStrictEqual(yield* f.home.durable, before);
      if (drift === "symlink")
        assert.strictEqual(yield* f.fs.readLink(path), join(f.root, "outside"));
      else if (drift !== "source")
        assert.strictEqual(
          yield* f.fs.readFileString(join(path, "SKILL.md")),
          "changed native bytes\n",
        );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

for (const directory of ["empty", "nested-symlink"] as const)
  it.effect(`Library owner previews a foreign ${directory} directory without changing it`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = join(f.destination, "alpha");
      yield* f.fs.makeDirectory(path, { recursive: true });
      if (directory === "nested-symlink") {
        yield* f.fs.writeFileString(join(path, "SKILL.md"), "foreign\n");
        yield* f.fs.symlink(f.root, join(path, "link"));
      }
      const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const plan = yield* f.home.owned(
        selection.plan(
          {
            subject: f.request.query,
            members: ["alpha"],
            enabled: true,
            where: [{ kind: "global" }],
          },
          f.home.installOptions,
        ),
      );
      assert.ok(plan.owner);
      assert.ok(plan.owner.plan.folders.some((e) => e.path === path && e.entry._tag !== "Absent"));
      const failure = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
      assert.instanceOf(failure, SetEnabledIncomplete);
      assert.strictEqual(yield* f.fs.exists(join(path, ".skit-ownership.json")), false);
      if (directory === "nested-symlink")
        assert.strictEqual(yield* f.fs.readLink(join(path, "link")), f.root);
      else assert.deepStrictEqual(yield* f.fs.readDirectory(path), []);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

it.effect(
  "Library owner checks one batch baseline when the same destination is enabled twice",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const intent = {
        subject: f.request.query,
        members: ["alpha"],
        enabled: true,
        where: [{ kind: "global" as const }],
      };
      const plan = yield* f.home.owned(selection.planMany([intent, intent], f.home.installOptions));
      const results = yield* f.home.owned(applySetEnabledPlan(plan));
      assert.strictEqual(results.length, 2);
      assert.strictEqual(
        (yield* f.home.durable).installed_skills.filter(
          (copy) => copy.path === join(f.destination, "alpha"),
        ).length,
        1,
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("an unwritable root keeps bindings unchanged and records its stopped attempt", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const selection = yield* f.home.owned(
      openSetEnabledSession(f.home.installOptions).pipe(
        withSandboxDenying(join(f.root, "account", ".agents")),
      ),
    );
    const plan = yield* f.home.owned(
      selection.plan(
        {
          subject: f.request.query,
          members: ["alpha"],
          enabled: true,
          where: [{ kind: "global" }],
        },
        f.home.installOptions,
      ),
    );
    const before = yield* f.home.durable;
    const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
    assert.instanceOf(error, SkillsDirectoryNotWritable);
    const after = yield* f.home.durable;
    assert.deepStrictEqual({ ...after, operations: before.operations }, before);
    const attempt = after.operations.find(
      (item) => !before.operations.some((prior) => prior.operationId === item.operationId),
    );
    assert.ok(attempt);
    assert.strictEqual(attempt._tag, "Stopped");
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("Library owner rejects forged destination coordinates in a plain plan", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
    const plan = yield* f.home.owned(
      selection.plan(
        {
          subject: f.request.query,
          members: ["alpha"],
          enabled: true,
          where: [{ kind: "global" }],
        },
        f.home.installOptions,
      ),
    );
    assert.ok(plan.owner);
    const outside = join(f.root, "unreviewed");
    const forged = {
      ...plan,
      owner: {
        ...plan.owner,
        plan: {
          ...plan.owner.plan,
          routes: plan.owner.plan.routes.map((route) => ({
            ...route,
            destinations: route.destinations.map((target) => ({ ...target, root: outside })),
          })),
        },
      },
    };
    const before = yield* f.home.durable;
    const error = yield* f.home.owned(applySetEnabledPlan(forged)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.StalePlan");
    assert.deepStrictEqual(yield* f.home.durable, before);
    assert.strictEqual(yield* f.fs.exists(outside), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "Library owner records a displaced predecessor as pending when its successor rename fails",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const initial = yield* f.home.owned(
        first.plan(
          {
            subject: f.request.query,
            members: ["alpha"],
            enabled: true,
            where: [{ kind: "global" }],
          },
          f.home.installOptions,
        ),
      );
      yield* f.home.owned(applySetEnabledPlan(initial));
      const before = yield* f.home.durable;
      const old = before.installed_skills[0];
      assert.ok(old);
      const path = join(f.destination, "alpha");
      const selection = yield* f.home.owned(
        openSetEnabledSession(f.home.installOptions).pipe(
          Effect.provideServiceEffect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (fs) => ({
              ...fs,
              rename: (from: string, to: string) =>
                to === path
                  ? Effect.fail(
                      systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                      }),
                    )
                  : fs.rename(from, to),
            })),
          ),
        ),
      );
      const plan = yield* f.home.owned(
        selection.plan(
          {
            subject: f.request.query,
            members: ["alpha"],
            enabled: true,
            invocation: "explicit",
            where: [{ kind: "global" }],
          },
          f.home.installOptions,
        ),
      );

      const error = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
      assert.instanceOf(error, SetEnabledIncomplete);
      const row = (yield* f.home.durable).installed_skills.find(
        (copy) => copy.installed_skill_id === old.installed_skill_id,
      );
      assert.strictEqual(row?.status, "pending");
      assert.strictEqual(row?.skill_version_id, old.skill_version_id);
      assert.strictEqual(row?.expected_hash, old.expected_hash);
      assert.strictEqual(yield* f.fs.exists(path), false);
      const backups = (yield* f.fs.readDirectory(
        join(f.destination, "..", ".skit-backups"),
      )).filter((name) => name.startsWith("pending-"));
      assert.strictEqual(backups.length, 1);
      assert.strictEqual(
        yield* f.fs.readFileString(
          join(f.destination, "..", ".skit-backups", backups[0], "SKILL.md"),
        ),
        "# alpha\n",
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "Library owner leaves the predecessor row unchanged when a present successor fails verification",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const initial = yield* f.home.owned(
        first.plan(
          {
            subject: f.request.query,
            members: ["alpha"],
            enabled: true,
            where: [{ kind: "global" }],
          },
          f.home.installOptions,
        ),
      );
      yield* f.home.owned(applySetEnabledPlan(initial));
      const old = (yield* f.home.durable).installed_skills[0];
      assert.ok(old);
      const path = join(f.destination, "alpha");
      const selection = yield* f.home.owned(
        openSetEnabledSession(f.home.installOptions).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                yield* f.fs.rename(from, to);
                if (to === path)
                  yield* f.fs.writeFileString(
                    join(path, "SKILL.md"),
                    "Independent edit immediately after successor installation\n",
                  );
              }),
          }),
        ),
      );
      const plan = yield* f.home.owned(
        selection.plan(
          {
            subject: f.request.query,
            members: ["alpha"],
            enabled: true,
            invocation: "explicit",
            where: [{ kind: "global" }],
          },
          f.home.installOptions,
        ),
      );
      const failed = yield* f.home.owned(applySetEnabledPlan(plan)).pipe(Effect.flip);
      assert.instanceOf(failed, SetEnabledIncomplete);
      assert.deepStrictEqual(
        (yield* f.home.durable).installed_skills.find(
          (copy) => copy.installed_skill_id === old.installed_skill_id,
        ),
        old,
      );
      assert.strictEqual(yield* f.fs.exists(path), true);
      const pending = (yield* f.fs.readDirectory(
        join(f.destination, "..", ".skit-backups"),
      )).filter((name) => name.startsWith("pending-"));
      assert.strictEqual(pending.length, 1);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

for (const extras of ["reproducible", "empty-directory"] as const)
  it.effect(`Library owner settles an acknowledged uninstall backup (${extras})`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const initial = yield* f.home.owned(planSetEnabled([f.request], f.home.installOptions));
      yield* f.home.owned(applySetEnabledPlan(initial));
      if (extras === "empty-directory")
        yield* f.fs.makeDirectory(join(f.destination, "alpha", "notes"));
      const selection = yield* f.home.owned(openSetEnabledSession(f.home.installOptions));
      const plan = yield* f.home.owned(
        selection.plan(
          {
            subject: f.request.query,
            members: ["alpha"],
            enabled: false,
            where: [{ kind: "global" }],
          },
          f.home.installOptions,
        ),
      );
      yield* f.home.owned(applySetEnabledPlan(plan));
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
      assert.deepStrictEqual((yield* f.home.durable).installed_skills, []);
      const backups = (yield* f.fs.readDirectory(
        join(f.destination, "..", ".skit-backups"),
      )).filter((name) => name !== ".gitignore");
      assert.strictEqual(backups.length, extras === "reproducible" ? 0 : 1);
      if (extras === "empty-directory") {
        assert.ok(backups[0].startsWith("kept-"));
        assert.deepStrictEqual(
          yield* f.fs.readDirectory(
            join(f.destination, "..", ".skit-backups", backups[0], "notes"),
          ),
          [],
        );
      }
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );
