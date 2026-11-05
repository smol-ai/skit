import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { applySetEnabledPlan, openSetEnabledSession } from "../src/library/session.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect(
  "a core selection captures its configured owner, refuses another home and applies without frontend services",
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
      ).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
      const configuration = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: [destination] },
      };
      const selection = yield* openSetEnabledSession(home, configuration);
      const plan = yield* selection.plan(
        { subject: "review", enabled: true, where: [{ kind: "global" }] },
        configuration,
      );
      assert.isFalse(yield* fs.exists(destination));
      const elsewhere = join(root, "another-library");
      const refused = yield* Effect.result(applySetEnabledPlan(elsewhere, plan));
      assert.strictEqual(refused._tag, "Failure");
      if (refused._tag === "Failure") assert.strictEqual(refused.failure._tag, "Library.StalePlan");
      assert.isFalse(yield* fs.exists(elsewhere));
      assert.isFalse(yield* fs.exists(destination));
      // The prepared operation captures the owner; applying requires no ambient store or platform.
      const applying: Effect.Effect<unknown, unknown> = applySetEnabledPlan(home, plan);
      yield* applying;
      assert.strictEqual(yield* fs.readFileString(join(destination, "review", "SKILL.md")), bytes);
      const snapshot = yield* Effect.flatMap(Library.Service, (library) => library.read).pipe(
        Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
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
      }).pipe(
        Effect.provide(Library.layer({ home, routing: { _tag: "Configured", ...configuration } })),
      );
    }).pipe(Effect.provide(skitLayer)),
);
