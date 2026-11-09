import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { skitLayer } from "../src/platform/layer.js";
import { authorLayer, updateAuthoredSkills } from "../src/author/operations.js";
import { initializeAuthorWorkspace } from "../src/author/initialize.js";

it.effect(
  "matching workspace/release names remain distinguishable, queryable and independently removable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-source-identity-" }),
      );
      const home = join(directory, "home");
      const roots = [join(directory, "first/skills"), join(directory, "second/skills")];
      const agents = join(directory, "installed");
      const initial = "---\nname: review\ndescription: Review code\n---\nOriginal release\n";
      for (const root of roots) {
        yield* fs.makeDirectory(join(root, "skills/review"), { recursive: true });
        yield* fs.writeFileString(join(root, "skills/review/SKILL.md"), initial);
        yield* fs.writeFileString(
          join(root, "skit.json"),
          JSON.stringify({ slug: "skills", skills: [{ name: "review", path: "skills/review" }] }),
        );
      }
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const first = yield* initializeAuthorWorkspace(roots[0]!, home);
        const second = yield* initializeAuthorWorkspace(roots[1]!, home);
        yield* fs.writeFileString(
          join(roots[0]!, "skit.remote.json"),
          JSON.stringify({
            schema: "skit.remote.v1",
            origin: "https://registry.example",
            namespace: "tim",
            skit: "skills",
          }),
        );
        const published = yield* library.import.authored({
          root: roots[0]!,
          input: "skit://registry.example/tim/skills",
          label: "tim/skills",
          source: {
            type: "registry",
            authority: "https://registry.example",
            namespace: "tim",
            slug: "skills",
          },
          revision: { kind: "release", version: "1.0.0" },
          importedAt: "2026-11-09T00:00:00Z",
        });
        const listed = yield* library.list();
        const a = listed.collections.find(
          (item) => item.id === first.entry.collection.collection_id,
        )!;
        const b = listed.collections.find(
          (item) => item.id === second.entry.collection.collection_id,
        )!;
        const release = listed.collections.find(
          (item) => item.id === published.collection.collection_id,
        )!;
        assert.strictEqual(a.collectionSource?.name, "tim/skills");
        assert.strictEqual(a.collectionSource?.kind, "authored-workspace");
        assert.strictEqual(a.collectionSource?.locator, roots[0]);
        assert.strictEqual(a.collectionSource?.authority, "https://registry.example");
        assert.strictEqual(b.collectionSource?.workspace_status, "unconnected");
        assert.strictEqual(b.collectionSource?.locator, roots[1]);
        assert.strictEqual(release.collectionSource?.kind, "registry");
        assert.strictEqual(release.collectionSource?.revision, "1.0.0");

        const enabled = yield* library.planEnabled(
          [
            {
              subject: published.collection.collection_id,
              enabled: true,
              members: "whole",
              where: [{ kind: "global" }],
            },
          ],
          { base: yield* library.read },
        );
        yield* library.apply({ _tag: "Apply", plan: enabled.plan });
        const updated = initial.replace("Original release", "Workspace edit");
        yield* fs.writeFileString(join(roots[0]!, "skills/review/SKILL.md"), updated);
        const observed = yield* updateAuthoredSkills(roots[0]!);
        assert.deepStrictEqual(observed.context?.disabled_skills, ["review"]);
        assert.strictEqual(observed.context?.other_sources[0]?.source?.kind, "registry");
        assert.strictEqual(yield* fs.readFileString(join(agents, "review/SKILL.md")), initial);

        yield* library.remove({ query: published.collection.collection_id, dryRun: false });
        const afterRemoval = yield* library.list();
        assert.isTrue(afterRemoval.collections.some((item) => item.id === a.id));
        const chooseWorkspace = yield* library.planEnabled(
          [{ subject: roots[0]!, enabled: true, members: "whole", where: [{ kind: "global" }] }],
          { base: yield* library.read },
        );
        yield* library.apply({ _tag: "Apply", plan: chooseWorkspace.plan });
        assert.strictEqual(yield* fs.readFileString(join(agents, "review/SKILL.md")), updated);
        const before = yield* library.read;
        const preview = yield* library.remove({ query: roots[0]!, dryRun: true });
        assert.strictEqual(preview.value.collection_source?.kind, "authored-workspace");
        assert.strictEqual((yield* library.read).revision, before.revision);
        assert.strictEqual(
          yield* fs.readFileString(join(roots[0]!, "skills/review/SKILL.md")),
          updated,
        );

        // A copied identity must not borrow another workspace's connected name.
        const identity = yield* fs.readFileString(join(roots[0]!, ".skit/workspace.json"));
        yield* fs.writeFileString(join(roots[1]!, ".skit/workspace.json"), identity);
        const mismatch = (yield* library.list()).collections.find((item) => item.id === b.id)!;
        assert.strictEqual(mismatch.collectionSource?.workspace_status, "identity-mismatch");
        assert.isUndefined(mismatch.collectionSource?.authority);
        yield* fs.rename(roots[1]!, `${roots[1]}-moved`);
        const missing = (yield* library.list()).collections.find((item) => item.id === b.id)!;
        assert.strictEqual(missing.collectionSource?.workspace_status, "unavailable");
        assert.strictEqual(missing.collectionSource?.locator, roots[1]);
        assert.strictEqual((yield* library.read).revision, before.revision);
      }).pipe(
        Effect.provide(
          Library.layer({
            home,
            roots: {
              home: directory,
              configHome: join(directory, "config"),
              overrides: { codex: [agents] },
            },
          }).pipe(Layer.provideMerge(authorLayer({ home }))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
