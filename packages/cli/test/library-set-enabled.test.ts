import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  LibraryStore,
  libraryStoreLayer,
  skitLayer,
} from "@smolai/skit-core";
import { isolatedRoots } from "./helpers/isolated-library.js";
import { applyLibraryBindings } from "../src/workflows/library/set-enabled.js";
import { initializeLibraryMachine, retainObservedIn, writingTo } from "./helpers/library-home.js";

it.effect("partially binds raw Skills and converges after enable and disable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-enable-" });
    const roots = isolatedRoots(workspace);
    const home = roots.home;
    const observed = join(workspace, "observed");
    yield* initializeLibraryMachine(home);
    const review = join(observed, "review");
    const test = join(observed, "test");
    for (const path of [review, test]) yield* fs.makeDirectory(path, { recursive: true });
    yield* fs.writeFileString(join(review, "SKILL.md"), "review raw bytes\n");
    yield* fs.writeFileString(join(test, "SKILL.md"), "test raw bytes\n");
    const collection = yield* Effect.scoped(
      writingTo(
        home,
        retainObservedIn(home)({
          identity: { profile: "local-collection", version: 1, path: observed },
          input: observed,
          retainedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: review,
              relativePath: "review",
              observedHash: yield* deterministicTreeHashEffect(review),
            },
            {
              name: "test",
              sourcePath: test,
              relativePath: "test",
              observedHash: yield* deterministicTreeHashEffect(test),
            },
          ],
          observations: [],
        }),
      ),
    );
    const layer = libraryStoreLayer({ home });
    const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(state);
    const base = {
      libraryHome: home,
      query: collection.collection?.collection_id ?? "",
      all: false,
      selectedSkills: ["review"],
      roots: {
        home: workspace,
        configHome: join(workspace, "config"),
        overrides: {
          codex: roots.codexRoot,
          claude: roots.claudeRoot,
          opencode: roots.opencodeRoot,
          devin: roots.devinRoots,
        },
      },
      variantsPath: join(home, "variants"),
      now: () => "2026-09-16T00:00:00.000Z",
    };
    const invocation = {
      subjects: [collection.collection?.collection_id ?? ""],
      harnesses: ["codex" as const],
      scope: { kind: "global" as const },
      enabled: true,
      dryRun: true,
    };
    const planned = yield* applyLibraryBindings(state, {
      ...base,
      invocation,
    }).pipe(Effect.provide(layer));
    assert.strictEqual(planned.kind, "plan");
    assert.deepEqual(planned.value.skills, ["review"]);
    assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "review")), false);
    const beforeApply = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.deepEqual(beforeApply?.global_bindings, []);

    yield* writingTo(
      home,
      LibraryStore.use((store) =>
        store.publish({ ...state, custodyIssues: state.custodyIssues ?? [] }),
      ).pipe(Effect.provide(layer)),
    );
    const stale = yield* applyLibraryBindings(state, {
      ...base,
      invocation: { ...invocation, dryRun: false },
    }).pipe(Effect.provide(layer), Effect.flip);
    assert.strictEqual(stale._tag, "Library.SetEnabledStale");
    yield* writingTo(
      home,
      LibraryStore.use((store) => store.publish(state)).pipe(Effect.provide(layer)),
    );

    const apply = (enabled: boolean) =>
      Effect.gen(function* () {
        const current = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
        assert.ok(current);
        return yield* applyLibraryBindings(current, {
          ...base,
          invocation: { ...invocation, enabled, dryRun: false },
        }).pipe(Effect.provide(layer));
      });
    const enabled = yield* writingTo(home, apply(true));
    assert.strictEqual(enabled.kind, "applied");
    assert.strictEqual(enabled.value.changed, true);
    assert.strictEqual(
      yield* fs.readFileString(join(roots.codexRoot, "review", "SKILL.md")),
      "review raw bytes\n",
    );
    assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "test")), false);
    const retained = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    const reviewSkillId = retained?.skills.find((skill) => skill.name === "review")?.skill_id;
    assert.ok(reviewSkillId);
    assert.deepEqual(retained?.global_bindings[0]?.skills, [reviewSkillId]);
    const repeated = yield* writingTo(home, apply(true));
    assert.strictEqual(repeated.value.changed, false);
    const disabled = yield* writingTo(home, apply(false));
    assert.strictEqual(disabled.value.changed, true);
    assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "review")), false);
    const final = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.deepEqual(final?.global_bindings, []);
    assert.strictEqual(final?.skills.find((skill) => skill.name === "review")?.versions.length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
