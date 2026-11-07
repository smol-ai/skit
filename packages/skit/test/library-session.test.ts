import { openLibraryView } from "../src/library/internal/session/library-view.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

it.effect(
  "explicit Library queries and data-only plans retain the reviewed revision across another ambient Library",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-core-selection-" }),
      );
      const home = join(root, "library");
      const source = join(root, "source");
      const destination = join(root, "skills");
      const bytes =
        "---\nname: review\ndescription: Core selection fixture\n---\nOriginal bytes.\n";
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
      const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Expected an observed source");
      yield* Effect.flatMap(Library.Service, (library) =>
        library.import.collection(request.value),
      ).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
      const configuration = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: [destination] },
      };
      const library = yield* Library.Service.pipe(
        Effect.provide(Library.layer({ home, roots: configuration })),
      );
      const base = yield* library.read;
      const choices = yield* library.list({ base });
      const plan = yield* library.planEnabled(
        [
          {
            subject: "review",
            enabled: true,
            where: [{ kind: "global" }],
          },
        ],
        { base },
      );
      const portablePlan = structuredClone(plan);
      assert.deepStrictEqual(portablePlan, plan);
      assert.deepStrictEqual(Reflect.ownKeys(plan), ["plan", "changes"]);
      assert.isFalse(yield* fs.exists(destination));
      const elsewhere = join(root, "another-library");
      const other = yield* Library.Service.pipe(
        Effect.provide(Library.layer({ home: elsewhere, roots: testRoots(elsewhere) })),
      );
      // The reviewed operation needs no ambient owner or platform and cannot be redirected.
      const applying: Effect.Effect<unknown, unknown> = library.apply({
        _tag: "Apply",
        plan: portablePlan.plan,
      });
      yield* applying.pipe(Effect.provideService(Library.Service, other));
      assert.isFalse(yield* fs.exists(elsewhere));
      assert.strictEqual(yield* fs.readFileString(join(destination, "review", "SKILL.md")), bytes);
      const view = yield* openLibraryView(home).pipe(
        Effect.provide(Library.layer({ home, roots: testRoots(home) })),
      );
      assert.deepStrictEqual(
        view.installedSkills.map(({ name, path, destination, status }) => ({
          name,
          path,
          destination,
          status,
        })),
        [
          {
            name: "review",
            path: join(destination, "review"),
            destination: "agents",
            status: "installed",
          },
        ],
      );
      // The selection's earlier read model remains the evidence from before applying.
      assert.deepStrictEqual(choices.installedSkills, []);
      assert.deepStrictEqual((yield* library.list({ base })).enabledEverywhere.items, []);
      const portable = yield* view.readManifest();
      assert.strictEqual(portable.enabled.length, 1);
      for (const field of ["operations", "installed_skills", "repositories", "sync_ancestry"])
        assert.isFalse(Object.hasOwn(portable, field));
      const collection = portable.collections[0];
      assert.ok(collection);
      const label = collection.label;
      Reflect.set(collection, "label", "Changed by the reader");
      assert.strictEqual((yield* view.readManifest()).collections[0]?.label, label);
      const snapshot = yield* Effect.flatMap(Library.Service, (library) => library.read).pipe(
        Effect.provide(Library.layer({ home, roots: testRoots(home) })),
      );
      assert.strictEqual(snapshot._tag, "Present");
      if (snapshot._tag === "Present") assert.strictEqual(snapshot.state.enabled.length, 1);
      if (snapshot._tag !== "Present" || !snapshot.state.skills[0])
        return assert.fail("No imported Skill");
      const collectionId = snapshot.state.skills[0].collection_id;
      const repository = join(root, "project");
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Collection", id: collectionId },
                members: "whole",
                where: [{ kind: "repository", root: repository }],
              },
            ],
          },
          { base: yield* library.read },
        );
        const outcome = (yield* library.apply({ _tag: "Apply", plan })).result;
        assert.strictEqual(outcome._tag, "Applied");
        assert.strictEqual(outcome.results.length, 1);
        assert.strictEqual(outcome.results[0]?.failure, null);
        assert.strictEqual(outcome.results[0]?.copies.length, 1);
        assert.isTrue(
          outcome.results[0]?.copies.every(
            (copy) =>
              copy._tag !== "Failed" && copy.copy.root === join(repository, ".agents", "skills"),
          ),
        );
        assert.strictEqual(outcome._tag === "Applied" && outcome.copies.length, 2);
      }).pipe(Effect.provide(Library.layer({ home, roots: configuration })));
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("an absent Library exposes empty read facts without creating persisted state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-empty-view-" });
    const home = join(root, "absent");
    const view = yield* openLibraryView(home).pipe(
      Effect.provide(Library.layer({ home, roots: testRoots(home) })),
    );
    assert.deepStrictEqual(view.installedSkills, []);
    assert.deepStrictEqual(view.skillsShCollectionIds, []);
    const portable = yield* view.readManifest();
    assert.deepStrictEqual(portable.collections, []);
    assert.deepStrictEqual(portable.enabled, []);
    assert.isFalse(yield* fs.exists(home));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
