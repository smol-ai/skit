import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect, LibraryStore } from "@smolai/skit-core";
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
