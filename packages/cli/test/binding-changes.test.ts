import { assert, it } from "@effect/vitest";
import { Clock, ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  inspectOwnershipMarkerEffect,
  LibraryStore,
  ProjectionRootNotWritable,
  skillUsageLayer,
  SkillUsage,
} from "@smolai/skit-core";
import { withSandboxDenying } from "./helpers/sandbox.js";
import {
  applyBindingChanges,
  openBindingChangeSelection,
  previewBindingChanges,
  type BindingChangeRequest,
} from "../src/library-application/binding-changes.js";
import {
  openLibrarySession,
  proposeLibraryCollectionChange,
  confirmLibraryChange,
} from "../src/library-application/session.js";
import { type ListingBudget, type UsageReport } from "@smolai/skit-core";
import { presentDoctorCleanup } from "../src/workflows/library/doctor-cleanup.js";
import {
  suggestDoctorCleanup,
  openDoctorCleanupSelection,
} from "../src/library-application/doctor-cleanup.js";
import { observedUsageStory } from "../src/storybook/usage-stories.js";
import { Prompter, PromptCancelled } from "../src/presentation/prompter.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { testPlatformLayer } from "./helpers/platform.js";
import {
  initializeLibraryMachine,
  libraryHome,
  retainObservedIn,
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
        observedHash: yield* deterministicTreeHashEffect(path),
      };
    }),
  );
  yield* home.owned(
    writingTo(
      home.home,
      retainObservedIn(home.home)({
        source: { type: "local", path: source },
        input: source,
        retainedAt: "2026-10-16T00:00:00.000Z",
        skills,
        observations: [],
      }),
    ),
  );
  const collection = (yield* home.durable).collections[0];
  assert.ok(collection);
  const request: BindingChangeRequest = {
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
    yield* f.home.owned(
      writingTo(
        f.home.home,
        LibraryStore.use((store) =>
          Effect.flatMap(store.load, (state) =>
            store.publish(
              {
                ...state,
                global_bindings: [
                  {
                    scope: { kind: "global" },
                    entries: [
                      {
                        kind: "skill",
                        skill_id: state.skills.find((skill) => skill.name === "beta")!.skill_id,
                      },
                    ],
                  },
                ],
                device_skill_selection: {
                  mode: "choose",
                  binding: { scope: { kind: "global" }, entries: [] },
                },
              },
              state,
            ),
          ),
        ),
      ),
    );
    const account = (yield* f.home.durable).global_bindings;
    const plan = yield* f.home.owned(previewBindingChanges([f.request], f.home.bindings));
    yield* f.home.owned(applyBindingChanges(plan));
    const after = yield* f.home.durable;
    assert.deepStrictEqual(after.global_bindings, account);
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
      yield* f.home.owned(
        writingTo(
          f.home.home,
          LibraryStore.use((store) =>
            Effect.flatMap(store.load, (state) =>
              store.publish(
                {
                  ...state,
                  global_bindings: [
                    {
                      scope: { kind: "global" },
                      entries:
                        accountBinding === "follows-collection"
                          ? [{ kind: "collection", collection_id: collection.collection_id }]
                          : [],
                    },
                  ],
                  device_skill_selection: {
                    mode: "choose",
                    binding: { scope: { kind: "global" }, entries: [] },
                  },
                },
                state,
              ),
            ),
          ),
        ),
      );
      const enabled = yield* f.home.owned(
        previewBindingChanges(
          [{ ...f.request, selectedSkills: ["alpha", "beta"] }],
          f.home.bindings,
        ),
      );
      yield* f.home.owned(applyBindingChanges(enabled));
      const account = (yield* f.home.durable).global_bindings;
      const selection = yield* f.home.owned(openBindingChangeSelection());
      const before = yield* f.fs.readFileString(f.home.statePath);
      const plan = yield* f.home.owned(
        selection.previewMany(
          ["alpha", "beta"].map((name) => ({
            subject: f.request.query,
            enabled: false,
            members: [name],
            where: [{ kind: "global" }],
          })),
          f.home.bindings,
        ),
      );
      assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
      assert.strictEqual(plan.changes[0]?.bindings[0]?.entries.length, 1);
      assert.strictEqual(plan.changes[1]?.bindings[0]?.entries.length, 0);
      const outcomes = yield* f.home.owned(applyBindingChanges(plan));
      assert.deepStrictEqual(outcomes[0]?.value.bindings, plan.changes[0]?.bindings);
      assert.deepStrictEqual(outcomes[1]?.value.bindings, []);
      const after = yield* f.home.durable;
      assert.deepStrictEqual(
        after.global_bindings,
        accountBinding === "follows-collection" ? account : [],
      );
      assert.deepStrictEqual(after.device_skill_selection, {
        mode: "choose",
        binding: { scope: { kind: "global" }, entries: [] },
      });
      assert.isFalse(yield* f.fs.exists(join(f.destination, "alpha")));
      assert.isFalse(yield* f.fs.exists(join(f.destination, "beta")));
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("retrying an already selected device Skill still checks unmanaged copies", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.home.owned(
      writingTo(
        f.home.home,
        LibraryStore.use((store) =>
          Effect.flatMap(store.load, (state) =>
            store.publish(
              {
                ...state,
                device_skill_selection: {
                  mode: "choose",
                  binding: {
                    scope: { kind: "global" },
                    entries: [
                      {
                        kind: "skill",
                        skill_id: state.skills.find((skill) => skill.name === "alpha")!.skill_id,
                      },
                    ],
                  },
                },
              },
              state,
            ),
          ),
        ),
      ),
    );
    const native = join(f.home.inventory.home, ".codex", "skills", "alpha");
    yield* f.fs.makeDirectory(native, { recursive: true });
    yield* f.fs.writeFileString(join(native, "SKILL.md"), "native copy\n");
    const plan = yield* f.home.owned(
      previewBindingChanges([f.request], { ...f.home.bindings, overrides: {} }),
    );
    const error = yield* f.home.owned(applyBindingChanges(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProjectionWouldDuplicate");
    assert.strictEqual(yield* f.fs.readFileString(join(native, "SKILL.md")), "native copy\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("preparing a Binding plan changes neither Library metadata nor native copies", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* f.fs.readFileString(f.home.statePath);
    const plan = yield* f.home.owned(previewBindingChanges([f.request], f.home.bindings));
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
    const configuration = { ...f.home.bindings, overrides: { codex: routes } };
    const plan = yield* f.home.owned(
      previewBindingChanges([{ ...f.request, selectedSkills }], configuration),
    );
    selectedSkills.splice(0, 1, "beta");
    const redirected = join(f.root, "redirected");
    routes.splice(0, 1, redirected);
    yield* f.home.owned(applyBindingChanges(plan));
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
    const selection = yield* f.home.owned(openBindingChangeSelection());
    yield* f.home.owned(
      writingTo(
        f.home.home,
        LibraryStore.use((store) =>
          Effect.flatMap(store.load, (state) =>
            store.publish({ ...state, custodyIssues: [] }, state),
          ),
        ),
      ),
    );
    const plan = yield* f.home.owned(
      selection.preview(
        {
          subject: f.request.query,
          members: ["alpha"],
          enabled: true,
          where: [{ kind: "global" }],
        },
        f.home.bindings,
      ),
    );
    const error = yield* f.home.owned(applyBindingChanges(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.SetEnabledStale");
    assert.deepStrictEqual((yield* f.home.durable).global_bindings, []);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("rechecks duplicates created after preview before publishing Binding intent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* f.home.owned(
      previewBindingChanges([f.request], { ...f.home.bindings, overrides: {} }),
    );
    const nativeCopy = join(f.home.inventory.home, ".codex", "skills", "alpha");
    yield* f.fs.makeDirectory(nativeCopy, { recursive: true });
    yield* f.fs.writeFileString(join(nativeCopy, "SKILL.md"), "native copy\n");
    const error = yield* f.home.owned(applyBindingChanges(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProjectionWouldDuplicate");
    assert.deepStrictEqual((yield* f.home.durable).global_bindings, []);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
    assert.strictEqual(yield* f.fs.readFileString(join(nativeCopy, "SKILL.md")), "native copy\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("an unwritable root refuses enablement before publishing Binding intent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* f.home.owned(previewBindingChanges([f.request], f.home.bindings));
    const error = yield* f.home
      .owned(applyBindingChanges(plan))
      .pipe(withSandboxDenying(join(f.root, "account", ".agents")), Effect.flip);
    assert.instanceOf(error, ProjectionRootNotWritable);
    assert.strictEqual(error.root, f.destination);
    assert.deepStrictEqual((yield* f.home.durable).global_bindings, []);
    assert.strictEqual(yield* f.fs.exists(f.destination), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("refuses to apply a prepared plan to another Library", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* f.home.owned(previewBindingChanges([f.request], f.home.bindings));
    const other = yield* libraryHome({ home: join(f.root, "other-library") });
    const error = yield* other.owned(applyBindingChanges(plan)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.SetEnabledStale");
    assert.deepStrictEqual((yield* other.durable).global_bindings, []);
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
      const selection = yield* f.home.owned(openBindingChangeSelection());
      const plan = yield* f.home.owned(
        selection.preview(
          { subject: f.request.query, members, where, enabled: true },
          f.home.bindings,
        ),
      );
      yield* f.home.owned(applyBindingChanges(plan));
    }
    const selection = yield* f.home.owned(openBindingChangeSelection());
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
      selection.preview(
        {
          subject: f.request.query,
          enabled: false,
          members: ["alpha", "beta"],
          where: "where-enabled",
        },
        f.home.bindings,
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
      selection.preview(
        {
          subject: f.request.query,
          enabled: false,
          members: ["alpha"],
          where: "where-enabled",
        },
        f.home.bindings,
      ),
    );
    assert.strictEqual(onlyAlpha.changes.length, 1);
    assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
    yield* f.home.owned(applyBindingChanges(onlyAlpha));
    const settled = yield* f.home.durable;
    const beta = selection.view.collections[0]?.members.find((member) => member.name === "beta");
    assert.ok(beta);
    assert.deepStrictEqual(settled.global_bindings, []);
    assert.deepStrictEqual(settled.local_bindings[0]?.entries, [
      {
        kind: "skill",
        skill_id: beta.id,
      },
    ]);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a TUI proposal keeps the revision displayed before the proposal was made", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const displayed = yield* f.home.owned(openLibrarySession());
    yield* f.home.owned(
      writingTo(
        f.home.home,
        LibraryStore.use((store) =>
          Effect.flatMap(store.load, (state) =>
            store.publish({ ...state, custodyIssues: [] }, state),
          ),
        ),
      ),
    );
    const before = yield* f.fs.readFileString(f.home.statePath);
    const proposed = yield* f.home.owned(
      proposeLibraryCollectionChange(displayed, f.home.bindings, f.request.query, true, [
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
      previewBindingChanges([{ ...f.request, selectedSkills: ["alpha", "beta"] }], f.home.bindings),
    );
    yield* f.home.owned(applyBindingChanges(enabled));
    const selection = yield* f.home.owned(openBindingChangeSelection());
    const before = yield* f.fs.readFileString(f.home.statePath);
    const plan = yield* f.home.owned(
      selection.previewMany(
        ["alpha", "beta"].map((name) => ({
          subject: f.request.query,
          enabled: false,
          members: [name],
          where: [{ kind: "global" }],
        })),
        f.home.bindings,
      ),
    );
    assert.strictEqual(yield* f.fs.readFileString(f.home.statePath), before);
    assert.strictEqual(plan.changes[0]?.bindings[0]?.entries.length, 1);
    assert.strictEqual(plan.changes[1]?.bindings[0]?.entries.length, 0);
    yield* f.home.owned(applyBindingChanges(plan));
    assert.deepStrictEqual((yield* f.home.durable).global_bindings, []);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
    assert.strictEqual(yield* f.fs.exists(join(f.destination, "beta")), false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

const cleanupFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const enabled = yield* f.home.owned(
    previewBindingChanges([{ ...f.request, selectedSkills: ["alpha", "beta"] }], f.home.bindings),
  );
  yield* f.home.owned(applyBindingChanges(enabled));
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
    ...observedUsageStory,
    rows: [],
    incomplete: false,
    coverage: observedUsageStory.coverage.map((c) => ({ ...c, unsupported: 0 })),
  };
  return { ...f, budget, usage, state: yield* f.home.durable };
});

it.effect(
  "doctor ranks exact managed unused skills and selects only enough to cover the excess",
  () =>
    Effect.gen(function* () {
      const f = yield* cleanupFixture;
      const suggest = (usage = f.usage) =>
        suggestDoctorCleanup(f.state, [f.budget], usage, f.home.bindings);
      assert.deepStrictEqual(
        suggest().map((c) => [c.name, c.selected]),
        [
          ["alpha", true],
          ["beta", false],
        ],
      );
      // A name-only observation in another harness protects the skill across all projects.
      const used = { ...f.usage, rows: [{ ...observedUsageStory.rows[1]!, name: "alpha" }] };
      assert.deepStrictEqual(
        suggest(used).map((c) => c.name),
        ["beta"],
      );
      // Read-only evidence protects a managed skill even if it contributed no activation count.
      const read = {
        ...f.usage,
        rows: [
          {
            ...observedUsageStory.rows[0]!,
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

it.effect("cleanup uses one captured Library and an injected usage scanner", () =>
  Effect.gen(function* () {
    const f = yield* cleanupFixture;
    let loads = 0;
    const capturedStore = yield* f.home.owned(LibraryStore);
    const store = Layer.succeed(
      LibraryStore,
      LibraryStore.of({
        ...capturedStore,
        load: Effect.suspend(() => {
          loads++;
          return capturedStore.load;
        }),
      }),
    );
    const scanner = Layer.succeed(
      SkillUsage,
      SkillUsage.of({
        scan: (options) =>
          Effect.sync(() => {
            assert.strictEqual(loads, 1);
            assert.strictEqual(options.days, 14);
            assert.ok(options.projections?.some((p) => p.name === "alpha"));
            return f.usage;
          }),
      }),
    );
    const selection = yield* openDoctorCleanupSelection(
      [f.budget],
      f.home.bindings,
      14,
      () => Effect.void,
    ).pipe(Effect.provide(scanner), Effect.provide(store));
    assert.strictEqual(loads, 1);
    assert.strictEqual(selection.candidates.length, 2);
    const plan = yield* selection.preview(selection.candidates.map((c) => c.id));
    assert.strictEqual(loads, 1);
    assert.strictEqual(plan.changes.length, 1);
    yield* f.home.owned(applyBindingChanges(plan));
    assert.deepStrictEqual((yield* f.home.durable).global_bindings, []);
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
        presentDoctorCleanup([f.budget], f.home.bindings, 30, mode === "dry-run").pipe(
          Effect.provide(skillUsageLayer),
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
        previewBindingChanges([{ ...f.request, scope }], f.home.bindings),
      );
      yield* f.home.owned(applyBindingChanges(enable));
      const state = yield* f.home.durable;
      const local = state.projections.find(
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
        f.home.bindings,
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
          retainObservedIn(f.home.home)({
            source: { type: "local", path: source },
            input: source,
            retainedAt: "2026-10-18T00:00:00.000Z",
            observations: [],
            skills: [
              {
                name: "gamma",
                sourcePath: source,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(source),
              },
            ],
          }),
        ),
      );
      const gamma = (yield* f.home.durable).skills.find((s) => s.name === "gamma");
      assert.ok(gamma);
      const enabled = yield* f.home.owned(
        previewBindingChanges(
          [{ ...f.request, query: gamma.collection_id, selectedSkills: ["gamma"] }],
          f.home.bindings,
        ),
      );
      yield* f.home.owned(applyBindingChanges(enabled));
      const selection = yield* f.home.owned(openBindingChangeSelection());
      const plan = yield* f.home.owned(
        selection.previewMany(
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
          f.home.bindings,
        ),
      );
      const beta = (yield* f.home.durable).skills.find((s) => s.name === "beta");
      assert.ok(beta);
      assert.deepStrictEqual(plan.changes[1]?.bindings[0]?.entries, [
        { kind: "skill", skill_id: beta.skill_id },
      ]);
      yield* f.home.owned(applyBindingChanges(plan));
      assert.deepStrictEqual((yield* f.home.durable).global_bindings[0]?.entries, [
        { kind: "skill", skill_id: beta.skill_id },
      ]);
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "alpha")), false);
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "gamma")), false);
      assert.strictEqual(yield* f.fs.exists(join(f.destination, "beta")), true);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// `skit add ~/.claude/skills/x` then `skit enable x` is how an agent improvises setup: the
// destination already holds the user's own copy of the skill.
it.effect("enabling adopts an unmanaged copy that already holds the projected bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.makeDirectory(join(f.destination, "alpha"), { recursive: true });
    yield* f.fs.writeFileString(join(f.destination, "alpha", "SKILL.md"), "# alpha\n");
    const plan = yield* f.home.owned(previewBindingChanges([f.request], f.home.bindings));

    const [outcome] = yield* f.home.owned(applyBindingChanges(plan));

    assert.deepStrictEqual(
      outcome?.kind === "applied" ? outcome.value.projections.map((p) => p.status) : [],
      ["installed"],
    );
    assert.strictEqual(
      (yield* inspectOwnershipMarkerEffect(join(f.destination, "alpha"))).kind,
      "valid",
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a different copy at the destination is reported, and disabling leaves it in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const theirs = join(f.destination, "alpha", "SKILL.md");
    yield* f.fs.makeDirectory(join(f.destination, "alpha"), { recursive: true });
    yield* f.fs.writeFileString(theirs, "# alpha, edited by hand\n");
    const enable = yield* f.home.owned(previewBindingChanges([f.request], f.home.bindings));

    const [enabled] = yield* f.home.owned(applyBindingChanges(enable));

    assert.deepStrictEqual(
      enabled?.kind === "applied" ? enabled.value.projections.map((p) => p.status) : [],
      ["conflicted"],
    );
    const disable = yield* f.home.owned(
      previewBindingChanges([{ ...f.request, enabled: false }], f.home.bindings),
    );
    yield* f.home.owned(applyBindingChanges(disable));
    assert.strictEqual(yield* f.fs.readFileString(theirs), "# alpha, edited by hand\n");
    assert.deepStrictEqual((yield* f.home.durable).projections, []);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
