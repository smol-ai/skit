import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { prepareInstalledSkillRebuild } from "../src/installed-skills/files.js";
import { recoveryFingerprint } from "../src/library/folder-evidence.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect(
  "the installed-skill byte owner reconstructs a former independent copy from retained artifacts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-rebuild-" }),
      );
      const home = join(root, "library");
      const source = join(root, "source");
      const agents = join(root, "agents");
      const claude = join(root, "claude");
      const markdown = "---\nname: review\ndescription: review\n---\n\nOriginal bytes\n";
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(join(source, "SKILL.md"), markdown);
      const request = yield* localImportRequest(source, "2026-11-06T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Missing rebuild source");
      yield* Effect.gen(function* () {
        const owner = yield* Library.Service;
        const imported = yield* owner.import.collection(request.value);
        const plan = yield* owner.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Collection", id: imported.collection.collection_id },
                members: "whole",
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: yield* owner.read },
        );
        const applied = yield* owner.apply({ _tag: "Apply", plan });
        assert.strictEqual(applied.result._tag, "Applied");
        const snapshot = yield* owner.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Missing installed Library");
        const successor = join(claude, "review");
        const prior = snapshot.state.installed_skills.find((copy) => copy.path === successor);
        if (prior === undefined) return yield* Effect.die("Missing installed successor");
        const rebuilt = yield* prepareInstalledSkillRebuild(
          snapshot.state,
          join(home, "originals"),
          prior,
          { source: "declared" },
        );
        const stage = join(root, "reconstructed");
        assert.isFalse(yield* fs.exists(stage));
        yield* rebuilt.build(stage);
        assert.strictEqual(
          yield* recoveryFingerprint(stage, "exclude"),
          yield* recoveryFingerprint(successor, "exclude"),
        );
        assert.isFalse(yield* fs.exists(join(stage, ".skit-ownership.json")));
        yield* fs.writeFileString(join(stage, "SKILL.md"), "Independent writable copy");
        assert.strictEqual(yield* fs.readFileString(join(successor, "SKILL.md")), markdown);
      }).pipe(
        Effect.provide(
          Library.layer({
            home,
            routing: {
              _tag: "Configured",
              home: root,
              configHome: join(root, "config"),
              overrides: { codex: [agents], "claude-code": [claude] },
            },
          }),
        ),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
