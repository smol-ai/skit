import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";
import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { openSetEnabledSession } from "@smolai/skit-core/library/session";
import { importSource } from "../src/library/source.js";
import { planUpdates, updateSubjects } from "../src/library/update/operation.js";
import { setLibraryEnabled } from "./helpers/set-enabled.js";
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
          Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
          Effect.provide(skitConfigurationLayer(home)),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(rendererTestLayer()),
        );
      const load = run(
        Effect.flatMap(Library.Service, (library) => library.read).pipe(
          Effect.flatMap((snapshot) =>
            snapshot._tag === "Present"
              ? Effect.succeed(snapshot.state)
              : Effect.die("Expected imported Library"),
          ),
        ),
      );
      const added = yield* run(
        importSource({ type: "archive", url: "https://fixtures.test/plugins.tar" }),
      );
      const collectionId = added.collection_id!;
      const roots = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: [join(root, "codex")] },
      };
      const variantsPath = join(home, "variants");
      yield* writingTo(
        home,
        run(
          setLibraryEnabled({
            query: collectionId,
            all: true,
            roots,
            variantsPath,
            invocation: {
              scope: { kind: "global" },
              enabled: true,
              dryRun: false,
            },
          }),
        ),
      );
      const before = yield* load;
      yield* write("plugins/tools/.claude-plugin/plugin.json", '{"name":"tools"}');
      yield* skill("skills/review", "review", "After");
      yield* skill("plugins/tools/skills/review", "review", "After");
      yield* skill("plugins/tools/skills/added", "added");
      yield* fs.remove(join(source, "skills/deleted"), { recursive: true });
      bytes = yield* archive();
      const preview = yield* run(planUpdates());
      assert.deepStrictEqual(preview[0]?.removed, ["deleted"]);
      assert.deepStrictEqual(preview[0]?.enabled, ["added"]);
      const outcomes = yield* run(updateSubjects({ roots }));
      assert.strictEqual(outcomes.length, 1);
      assert.isFalse("status" in outcomes[0]!);
      const after = yield* load;
      assert.deepStrictEqual(after.collections, before.collections);
      assert.deepStrictEqual(after.enabled, before.enabled);
      const view = yield* run(
        openSetEnabledSession(home, { home: home, configHome: home, overrides: {} }).pipe(
          Effect.map((selection) => selection.view),
        ),
      );
      const collection = view.placements.find(
        (placement) => placement.collectionId === collectionId && placement.scope.kind === "global",
      );
      assert.ok(collection);
      assert.deepStrictEqual(
        collection.skillIds
          .map((skillId) => after.skills.find((entry) => entry.skill_id === skillId)?.path)
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
      const retry = yield* run(updateSubjects({ roots }));
      assert.isTrue("changed" in retry[0]! && retry[0].changed === false);
      const beforeConflict = yield* load;
      yield* skill("plugins/tools/skills/review", "review", "A different variant");
      bytes = yield* archive();
      const conflicted = yield* run(updateSubjects({ roots }));
      assert.isFalse("status" in conflicted[0]!);
      if ("changed" in conflicted[0]!) {
        assert.strictEqual(conflicted[0].changed, false);
        assert.strictEqual(conflicted[0].diagnostics?.[0]?.code, "plugin-member-held");
        assert.strictEqual(conflicted[0].diagnostics?.[0]?.path, "plugins/tools/skills/review");
      }
      assert.deepStrictEqual(yield* load, beforeConflict);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
