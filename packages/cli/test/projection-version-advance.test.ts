import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  currentSkillVersion,
  deterministicTreeHashEffect,
  LibraryStore,
  libraryStoreLayer,
  projectBindingEffect,
  refreshLibraryInventory,
  skitLayer,
} from "@smolai/skit-core";
import { applyLibraryBindings } from "../src/workflows/library/set-enabled.js";
import { reconcileLibraryProjections } from "../src/workflows/library/projection-reconciliation.js";
import { isolatedRoots } from "./helpers/isolated-library.js";
import { initializeLibraryMachine, retainObservedIn, writingTo } from "./helpers/library-home.js";

const boundRawReview = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-advance-" });
  const roots = isolatedRoots(workspace);
  const home = roots.home;
  const source = join(workspace, "raw-review");
  const layer = libraryStoreLayer({ home });
  yield* initializeLibraryMachine(home);
  yield* fs.makeDirectory(source, { recursive: true });
  const observe = (text: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(join(source, "SKILL.md"), text);
      return yield* Effect.scoped(
        writingTo(
          home,
          retainObservedIn(home)({
            source: { type: "local", path: source },
            input: source,
            retainedAt: "2026-09-16T00:00:00.000Z",
            skills: [
              {
                name: "raw-review",
                sourcePath: source,
                relativePath: "raw-review",
                observedHash: yield* deterministicTreeHashEffect(source),
              },
            ],
            observations: [],
          }),
        ),
      );
    });
  const first = yield* observe("first verbatim Skill\n");
  const bound = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
  assert.ok(bound);
  yield* writingTo(
    home,
    LibraryStore.use((store) =>
      store.publish({
        ...bound,
        global_bindings: [
          {
            scope: { kind: "global" },
            entries: bound.skills
              .filter((skill) => skill.collection_id === first.collection?.collection_id)
              .map((skill) => ({ kind: "skill" as const, skill_id: skill.skill_id })),
          },
        ],
      }),
    ).pipe(Effect.provide(layer)),
  );
  const project = writingTo(
    home,
    projectBindingEffect({
      target: "agents",
      root: roots.codexRoot,
      variantsPath: join(home, "variants"),
    }).pipe(Effect.provide(layer)),
  );
  yield* project;
  const projected = join(roots.codexRoot, "raw-review", "SKILL.md");
  assert.strictEqual(yield* fs.readFileString(projected), "first verbatim Skill\n");
  const projection = Effect.gen(function* () {
    const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(state);
    const row = state.projections.find((item) => item.target === "agents");
    assert.ok(row);
    const skill = state.skills[0];
    return {
      row,
      selected:
        skill === undefined ? undefined : currentSkillVersion(state, skill)?.skill_version_id,
    };
  });
  return { fs, home, roots, layer, observe, project, projected, projection };
});

it.effect("rewrites an untouched Projection when the selected Version advances", () =>
  Effect.gen(function* () {
    const { fs, observe, project, projected, projection } = yield* boundRawReview;
    yield* observe("second verbatim Skill\n");
    yield* project;
    assert.strictEqual(yield* fs.readFileString(projected), "second verbatim Skill\n");
    const { row, selected } = yield* projection;
    assert.strictEqual(row.status, "installed");
    assert.strictEqual(row.skill_version_id, selected);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps a locally edited Projection conflicted when the selected Version advances", () =>
  Effect.gen(function* () {
    const { fs, home, observe, project, projected, projection } = yield* boundRawReview;
    yield* fs.writeFileString(projected, "my local edit\n");
    yield* observe("second verbatim Skill\n");
    yield* project;
    assert.strictEqual(yield* fs.readFileString(projected), "my local edit\n");
    const { row } = yield* projection;
    assert.strictEqual(row.status, "conflicted");
    const variants = join(home, "variants", "agents", "raw-review");
    const [variant, ...others] = yield* fs.readDirectory(variants);
    assert.ok(variant);
    assert.deepStrictEqual(others, []);
    assert.strictEqual(
      yield* fs.readFileString(join(variants, variant, "SKILL.md")),
      "my local edit\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Before the fix, an update left untouched Projections recorded as conflicted at the new Version.
it.effect("heals an untouched Projection already recorded as conflicted", () =>
  Effect.gen(function* () {
    const { fs, home, layer, observe, project, projected, projection } = yield* boundRawReview;
    yield* observe("second verbatim Skill\n");
    const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(state);
    const selected =
      state.skills[0] === undefined
        ? undefined
        : currentSkillVersion(state, state.skills[0])?.skill_version_id;
    assert.ok(selected);
    yield* writingTo(
      home,
      LibraryStore.use((store) =>
        store.publish({
          ...state,
          projections: state.projections.map((row) => ({
            ...row,
            skill_version_id: selected,
            status: "conflicted" as const,
          })),
        }),
      ).pipe(Effect.provide(layer)),
    );
    yield* project;
    assert.strictEqual(yield* fs.readFileString(projected), "second verbatim Skill\n");
    const { row } = yield* projection;
    assert.strictEqual(row.status, "installed");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("re-enabling an unchanged Binding reconciles a changed global root", () =>
  Effect.gen(function* () {
    const { fs, home, roots, layer, projected } = yield* boundRawReview;
    const newRoot = join(home, "relocated", "skills");
    const before = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    const skillId = before.skills[0]?.skill_id;
    assert.ok(skillId);
    const changed = yield* writingTo(
      home,
      applyLibraryBindings(before, {
        query: skillId,
        all: false,
        roots: { home, configHome: join(home, "config"), overrides: { codex: newRoot } },
        variantsPath: join(home, "variants"),
        invocation: {
          subjects: [skillId],
          scope: { kind: "global" },
          enabled: true,
          dryRun: false,
        },
      }).pipe(Effect.provide(layer)),
    );
    assert.strictEqual(changed.kind, "applied");
    assert.strictEqual(changed.value.changed, false);
    assert.strictEqual(yield* fs.exists(projected), false);
    assert.strictEqual(
      yield* fs.readFileString(join(newRoot, "raw-review", "SKILL.md")),
      "first verbatim Skill\n",
    );
    const after = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.strictEqual(after.projections.filter((row) => row.root === roots.codexRoot).length, 0);
    assert.strictEqual(after.projections.filter((row) => row.root === newRoot).length, 1);
    assert.deepStrictEqual(after.global_bindings, before.global_bindings);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const followedCollection of [false, true])
  it.effect(
    `explicit enable recreates only the selected Projection (followed Collection=${followedCollection})`,
    () =>
      Effect.gen(function* () {
        const { fs, home, roots, layer, project, projected } = yield* boundRawReview;
        const load = LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
        const otherSource = join(home, "other-source");
        yield* fs.makeDirectory(otherSource);
        yield* fs.writeFileString(join(otherSource, "SKILL.md"), "other Skill bytes\n");
        const other = yield* writingTo(
          home,
          retainObservedIn(home)({
            source: { type: "local", path: otherSource },
            input: otherSource,
            retainedAt: "2026-09-16T00:00:00.000Z",
            skills: [
              {
                name: "other",
                sourcePath: otherSource,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(otherSource),
              },
            ],
            observations: [],
          }),
        );
        const otherId = other.skills[0]?.skill_id;
        assert.ok(otherId);
        const withOther = yield* load;
        const selectedSkill = withOther.skills.find((skill) => skill.name === "raw-review");
        assert.ok(selectedSkill);
        const skillId = selectedSkill.skill_id;
        yield* writingTo(
          home,
          LibraryStore.use((store) =>
            store.publish({
              ...withOther,
              global_bindings: withOther.global_bindings.map((binding) => ({
                ...binding,
                entries: [
                  ...(followedCollection
                    ? [
                        {
                          kind: "collection" as const,
                          collection_id: selectedSkill.collection_id,
                        },
                      ]
                    : binding.entries),
                  { kind: "skill" as const, skill_id: otherId },
                ],
              })),
            }),
          ).pipe(Effect.provide(layer)),
        );
        yield* project;
        yield* fs.remove(join(roots.codexRoot, "other"), { recursive: true });
        yield* fs.remove(join(roots.codexRoot, "raw-review"), { recursive: true });
        const installed = yield* load;
        yield* writingTo(
          home,
          refreshLibraryInventory(installed, () => []).pipe(Effect.provide(layer)),
        );
        const suppressed = yield* load;
        const suppressedRow = suppressed.projections.find(
          (row) => row.skill_id === skillId && row.target === "agents",
        );
        assert.strictEqual(suppressedRow?.status, "suppressed");
        assert.strictEqual(suppressedRow?.suppression_reason, "native_delete");
        yield* project;
        assert.strictEqual(yield* fs.exists(projected), false);
        const before = yield* load;

        const enable = (dryRun: boolean) =>
          writingTo(
            home,
            applyLibraryBindings(before, {
              query: skillId,
              all: false,
              roots: {
                home,
                configHome: join(home, "config"),
                overrides: { codex: roots.codexRoot },
              },
              variantsPath: join(home, "variants"),
              invocation: {
                subjects: [skillId],
                scope: { kind: "global" },
                enabled: true,
                dryRun,
              },
            }).pipe(Effect.provide(layer)),
          );
        const preview = yield* enable(true);
        assert.strictEqual(preview.kind, "plan");
        assert.strictEqual(yield* fs.exists(projected), false);
        assert.deepStrictEqual(yield* load, before);
        const applied = yield* enable(false);
        assert.strictEqual(applied.kind, "applied");
        assert.strictEqual(applied.value.changed, false);
        assert.strictEqual(yield* fs.readFileString(projected), "first verbatim Skill\n");
        const after = yield* load;
        const restored = after.projections.find(
          (row) => row.skill_id === skillId && row.target === "agents",
        );
        assert.strictEqual(restored?.status, "installed");
        assert.strictEqual(restored?.suppression_reason, undefined);
        assert.strictEqual(restored?.suppressed_at, undefined);
        assert.deepStrictEqual(after.global_bindings, before.global_bindings);
        assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "other")), false);
        assert.strictEqual(
          after.projections.find((row) => row.skill_id === otherId)?.suppression_reason,
          "native_delete",
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "reconciling without routing keeps intact copies rather than treating them as inactive",
  () =>
    Effect.gen(function* () {
      const { fs, home, layer, projected, projection } = yield* boundRawReview;
      const reconciled = yield* writingTo(
        home,
        reconcileLibraryProjections({ variantsPath: join(home, "variants") }).pipe(
          Effect.provide(layer),
        ),
      );
      assert.strictEqual(reconciled.retired, 0);
      assert.strictEqual(yield* fs.readFileString(projected), "first verbatim Skill\n");
      assert.strictEqual((yield* projection).row.status, "installed");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
