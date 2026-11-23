import { saveLibrary } from "./helpers/library-store.js";
import { loadLibrary, inspectLocalLibraryState } from "../src/library/store/library-store.js";
import { assert, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { emptyLibraryState } from "../src/library/library-state.js";
import { skitLayer } from "../src/platform/layer.js";

it("requires a Snapshot at the public planning type boundary", () => {
  expectTypeOf<
    Parameters<Library.Interface["plan"]>[1]["base"]
  >().toEqualTypeOf<Library.Snapshot>();
});

it.effect("a plan narrows by operation and a forged tag cannot redirect apply", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = join(yield* fs.makeTempDirectoryScoped({ prefix: "skit-plan-tag-" }), "library");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const plan = yield* library.plan({ _tag: "Update" }, { base: yield* library.read });
      expectTypeOf(plan).toEqualTypeOf<Extract<Library.Plan, { readonly _tag: "Update" }>>();
      expectTypeOf(plan.intent._tag).toEqualTypeOf<"Update">();
      assert.strictEqual(plan._tag, "Update");
      assert.isTrue(Schema.is(Library.Plan)(plan));
      for (const _tag of ["Uninstall", "Undo"]) {
        Object.assign(plan, { _tag });
        assert.isFalse(Schema.is(Library.Plan)(plan));
        const failure = yield* Effect.flip(library.apply({ _tag: "Apply", plan: plan }));
        assert.strictEqual(failure._tag, "Library.StalePlan");
        assert.isFalse(yield* fs.exists(home));
      }
      Object.assign(plan, { _tag: "Update" });
      const outcome = yield* library.apply({ _tag: "Apply", plan: plan });
      expectTypeOf(outcome).toEqualTypeOf<Extract<Library.Outcome, { readonly _tag: "Update" }>>();
      assert.strictEqual(outcome._tag, "Update");
      assert.strictEqual(outcome.result._tag, "Applied");
      assert.isFalse(yield* fs.exists(join(home, "skills")));
    }).pipe(
      Effect.provide(
        Library.layer({
          home,
          roots: {
            home,
            configHome: home,
            overrides: { codex: [join(home, "skills")] },
          },
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

for (const initiallyPresent of [false, true])
  it.effect(
    `a plan refuses when an ${initiallyPresent ? "empty" : "absent"} Library becomes ${initiallyPresent ? "absent" : "empty"}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-snapshot-plan-" });
        const home = join(root, "library");
        if (initiallyPresent) yield* saveLibrary(home, emptyLibraryState());
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          const snapshot = yield* library.read;
          assert.strictEqual(snapshot._tag, initiallyPresent ? "Present" : "Absent");
          const plan = yield* library.plan({ _tag: "Update" }, { base: snapshot });
          assert.strictEqual(plan.baseRevision, snapshot.revision);
          if (!initiallyPresent) assert.isFalse(yield* fs.exists(home));
          if (initiallyPresent) yield* fs.remove(home, { recursive: true });
          else yield* saveLibrary(home, emptyLibraryState());
          const result = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.strictEqual(result.failure._tag, "Library.StalePlan");
            if (result.failure._tag === "Library.StalePlan") {
              assert.strictEqual(result.failure.expected, snapshot.revision);
              assert.strictEqual(result.failure.actual, (yield* library.read).revision);
            }
          }
          assert.strictEqual((yield* inspectLocalLibraryState(home)).present, !initiallyPresent);
          assert.deepStrictEqual(yield* loadLibrary(home), emptyLibraryState());
        }).pipe(
          Effect.provide(
            Library.layer({
              home,
              roots: {
                home,
                configHome: join(home, "config"),
                overrides: { codex: [join(home, "skills")] },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  );

it.effect("planning refuses a changed Snapshot revision without writing the Library", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = join(yield* fs.makeTempDirectoryScoped(), "library");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const snapshot = yield* library.read;
      const result = yield* Effect.result(
        library.plan(
          { _tag: "Update" },
          {
            base: { ...snapshot, revision: Library.Revision.make("absent-but-changed") },
          },
        ),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "Library.StalePlan");
      assert.isFalse(yield* fs.exists(home));
      const plan = yield* library.plan({ _tag: "Update" }, { base: snapshot });
      assert.strictEqual(
        (yield* library.apply({ _tag: "Apply", plan: plan })).result._tag,
        "Applied",
      );
      assert.isFalse(yield* fs.exists(join(home, "skills")));
    }).pipe(
      Effect.provide(
        Library.layer({
          home,
          roots: {
            home,
            configHome: join(home, "config"),
            overrides: { codex: [join(home, "skills")] },
          },
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("all planning validates captured state, and a delayed plan owns its Snapshot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-snapshot-capture-" });
    yield* saveLibrary(home, emptyLibraryState());
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Expected a present Library");
      const planning = library.plan({ _tag: "Update" }, { base: snapshot });
      snapshot.state.repositories.push({ root: join(home, "later-project"), enabled: [] });
      const updateError = yield* Effect.flip(library.plan({ _tag: "Update" }, { base: snapshot }));
      const inventoryError = yield* Effect.flip(
        library.plan({ _tag: "RefreshInventory", roots: [] }, { base: snapshot }),
      );
      assert.strictEqual(updateError._tag, "Library.StalePlan");
      assert.strictEqual(inventoryError._tag, "Library.StalePlan");
      const captured = yield* planning;
      assert.strictEqual(captured.baseRevision, snapshot.revision);
      assert.strictEqual(
        (yield* library.apply({ _tag: "Apply", plan: captured })).result._tag,
        "Applied",
      );
      assert.deepStrictEqual(yield* loadLibrary(home), emptyLibraryState());
    }).pipe(
      Effect.provide(
        Library.layer({
          home,
          roots: {
            home,
            configHome: home,
            overrides: { codex: [join(home, "skills")] },
          },
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("an edit followed by its inverse does not revive a reviewed plan", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-snapshot-counter-" });
    const state = emptyLibraryState();
    yield* saveLibrary(home, state);
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const before = yield* library.read;
      const plan = yield* library.plan({ _tag: "Update" }, { base: before });
      yield* saveLibrary(home, {
        ...state,
        repositories: [{ root: join(home, "project"), enabled: [] }],
      });
      yield* saveLibrary(home, state);
      const after = yield* library.read;
      assert.deepStrictEqual(yield* loadLibrary(home), state);
      assert.notStrictEqual(after.revision, before.revision);
      const failure = yield* Effect.flip(library.apply({ _tag: "Apply", plan }));
      assert.strictEqual(failure._tag, "Library.StalePlan");
      const fresh = yield* library.plan({ _tag: "Update" }, { base: after });
      assert.strictEqual(
        (yield* library.apply({ _tag: "Apply", plan: fresh })).result._tag,
        "Applied",
      );
    }).pipe(
      Effect.provide(Library.layer({ home, roots: { home, configHome: home, overrides: {} } })),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
