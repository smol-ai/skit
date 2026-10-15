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
    const selection = yield* f.home.owned(openBindingChangeSelection(f.home.bindings));
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
    const plan = yield* f.home.owned(selection.preview([f.request]));
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
