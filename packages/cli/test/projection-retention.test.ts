import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  LibraryStore,
  libraryStoreLayer,
  projectPortableBindingEffect,
  skitLayer,
} from "@smolai/skit-core";
import {
  applyProjectionRetention,
  planProjectionRetention,
} from "../src/workflows/library/projection-retention.js";
import { initializeLibraryMachine, retainObservedIn, writingTo } from "./helpers/library-home.js";
import { isolatedRoots } from "./helpers/isolated-library.js";

it.effect(
  "retains explicitly selected Projection bytes and accepts only identical observations",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-projection-retain-" });
      const roots = isolatedRoots(workspace);
      const home = roots.home;
      const source = join(workspace, "source");
      const now = () => "2026-09-17T00:00:00.000Z";
      yield* initializeLibraryMachine(home);
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(join(source, "SKILL.md"), "original\n");
      const collection = yield* Effect.scoped(
        writingTo(
          home,
          retainObservedIn(home)({
            identity: { profile: "local-collection", version: 1, path: source },
            input: source,
            retainedAt: now(),
            skills: [
              {
                name: "review",
                sourcePath: source,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(source),
              },
            ],
            observations: [],
          }),
        ),
      );
      const storeLayer = libraryStoreLayer({ home });
      const initial = yield* LibraryStore.use((store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      const skill = initial.skills.find(
        (candidate) => candidate.collection_id === collection.collection_id,
      );
      assert.ok(skill);
      const harnesses = ["codex", "claude-code", "opencode"] as const;
      yield* writingTo(
        home,
        LibraryStore.use((store) =>
          store.publish({
            ...initial,
            global_bindings: harnesses.map((harness) => ({
              collection_id: collection.collection_id,
              harness,
              scope: { kind: "global" as const },
              skills: [skill.skill_id],
            })),
          }),
        ).pipe(Effect.provide(storeLayer)),
      );
      const rootByHarness = {
        codex: roots.codexRoot,
        "claude-code": roots.claudeRoot,
        opencode: roots.opencodeRoot,
      } as const;
      for (const harness of harnesses)
        yield* writingTo(
          home,
          projectPortableBindingEffect({
            collectionId: collection.collection_id,
            harness,
            root: rootByHarness[harness],
            variantsPath: join(home, "variants"),
          }).pipe(Effect.provide(storeLayer)),
        );
      yield* fs.writeFileString(join(roots.codexRoot, "review", "SKILL.md"), "selected change\n");
      yield* fs.writeFileString(
        join(roots.opencodeRoot, "review", "SKILL.md"),
        "selected change\n",
      );
      yield* fs.writeFileString(join(roots.claudeRoot, "review", "SKILL.md"), "different change\n");

      const before = yield* LibraryStore.use((store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      const options = {
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
        now,
      };
      const plan = yield* planProjectionRetention(before, options, skill.name, "codex").pipe(
        Effect.provide(libraryStoreLayer({ home })),
      );
      assert.strictEqual(plan.skill_id, skill.skill_id);
      assert.deepStrictEqual(
        plan.projections.map((projection) => [projection.harness, projection.agreement]),
        [
          ["codex", "selected"],
          ["claude-code", "different"],
          ["opencode", "identical"],
        ],
      );
      assert.strictEqual(before.skills[0]?.versions.length, 1);
      assert.strictEqual(yield* fs.exists(plan.retained_path), false);

      const result = yield* applyProjectionRetention(before, options, skill.name, "codex").pipe(
        Effect.provide(storeLayer),
      );
      assert.deepStrictEqual(
        result.projections.map((projection) => [projection.harness, projection.status]),
        [
          ["codex", "projected"],
          ["claude-code", "conflicted"],
          ["opencode", "projected"],
        ],
      );
      const after = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
      const retained = after.skills.find((candidate) => candidate.skill_id === skill.skill_id)!;
      assert.strictEqual(retained.versions.length, 2);
      assert.strictEqual(retained.selected_skill_version_id, result.retained_skill_version_id);
      assert.strictEqual(after.acquisitions.at(-1)?.source_identity.kind, "local");
      assert.strictEqual(
        yield* fs.readFileString(join(roots.codexRoot, "review", "SKILL.md")),
        "selected change\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(join(roots.opencodeRoot, "review", "SKILL.md")),
        "selected change\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(join(roots.claudeRoot, "review", "SKILL.md")),
        "different change\n",
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
