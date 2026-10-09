import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  currentCollectionSkills,
  LibraryStore,
  libraryStoreLayer,
  skitLayer,
} from "@smolai/skit-core";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { planUpdatesEffect, updateSubjectsEffect } from "../src/workflows/library/update.js";
import { applyLibraryBindings } from "../src/workflows/library/set-enabled.js";
import { writingTo } from "./helpers/library-home.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect(
  "preserves existing mixed membership, IDs and bindings while discovering additions and real deletions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plugin-update-" });
      const source = join(root, "source");
      const home = join(root, "library");
      const write = (path: string, text: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(join(source, path)), { recursive: true });
          yield* fs.writeFileString(join(source, path), text);
        });
      const skill = (path: string, name: string, body = "Before") =>
        write(`${path}/SKILL.md`, `---\nname: ${name}\ndescription: Test Skill.\n---\n\n${body}\n`);
      const archive = () =>
        Effect.gen(function* () {
          const path = join(root, "source.tar");
          yield* Effect.sync(() => execFileSync("tar", ["-cf", path, "-C", source, "."]));
          return yield* fs.readFile(path);
        });
      yield* skill("skills/review", "review");
      yield* skill("plugins/tools/legacy", "legacy");
      yield* skill("skills/deleted", "deleted");
      let bytes = yield* archive();
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array(bytes), {
              headers: { "content-type": "application/x-tar" },
            }),
          ),
        ),
      );
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(libraryStoreLayer({ home })),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(rendererTestLayer()),
        );
      const added = yield* run(
        addLibrarySourceEffect({ type: "archive", url: "https://fixtures.test/plugins.tar" }),
      );
      const collectionId = added.collection_id!;
      const roots = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: join(root, "codex") },
      };
      const variantsPath = join(home, "variants");
      const loaded = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
      yield* writingTo(
        home,
        run(
          applyLibraryBindings(loaded, {
            query: collectionId,
            all: true,
            roots,
            variantsPath,
            invocation: {
              subjects: [collectionId],
              scope: { kind: "global" },
              enabled: true,
              dryRun: false,
            },
          }),
        ),
      );
      const before = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
      yield* write("plugins/tools/.claude-plugin/plugin.json", '{"name":"tools"}');
      yield* skill("skills/review", "review", "After");
      yield* skill("plugins/tools/skills/review", "review", "After");
      yield* skill("plugins/tools/skills/added", "added");
      yield* fs.remove(join(source, "skills/deleted"), { recursive: true });
      bytes = yield* archive();
      const preview = yield* run(planUpdatesEffect(before, { roots, variantsPath }));
      assert.deepStrictEqual(preview[0]?.removed, ["deleted"]);
      assert.deepStrictEqual(preview[0]?.enabled, ["added"]);
      const outcomes = yield* run(updateSubjectsEffect(before, { roots, variantsPath }));
      assert.strictEqual(outcomes.length, 1);
      assert.isFalse("status" in outcomes[0]!);
      const after = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.deepStrictEqual(after.collections, before.collections);
      assert.deepStrictEqual(after.global_bindings, before.global_bindings);
      assert.deepStrictEqual(
        currentCollectionSkills(after, collectionId)
          .map((entry) => entry.path)
          .toSorted(),
        ["plugins/tools/legacy", "plugins/tools/skills/added", "skills/review"],
      );
      for (const original of before.skills)
        assert.strictEqual(
          after.skills.find((entry) => entry.path === original.path)?.skill_id,
          original.skill_id,
        );
      assert.strictEqual(after.skills.find((entry) => entry.name === "review")?.versions.length, 2);
      assert.strictEqual(
        after.skills.find((entry) => entry.name === "deleted")?.versions.length,
        1,
      );
      assert.isTrue(yield* fs.exists(join(root, "codex/legacy/SKILL.md")));
      assert.isTrue(yield* fs.exists(join(root, "codex/added/SKILL.md")));
      assert.isFalse(yield* fs.exists(join(root, "codex/deleted")));
      const retry = yield* run(updateSubjectsEffect(after, { roots, variantsPath }));
      assert.isTrue("changed" in retry[0]! && retry[0].changed === false);
      const beforeConflict = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
      yield* skill("plugins/tools/skills/review", "review", "A different variant");
      bytes = yield* archive();
      const conflicted = yield* run(updateSubjectsEffect(beforeConflict, { roots, variantsPath }));
      assert.isFalse("status" in conflicted[0]!);
      if ("changed" in conflicted[0]!) {
        assert.strictEqual(conflicted[0].changed, false);
        assert.strictEqual(conflicted[0].diagnostics?.[0]?.code, "plugin-member-held");
        assert.strictEqual(conflicted[0].diagnostics?.[0]?.path, "plugins/tools/skills/review");
      }
      assert.deepStrictEqual(
        yield* run(Effect.flatMap(LibraryStore, (store) => store.load)),
        beforeConflict,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
