import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import { Library } from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect(
  "Library constructs its storage and routes None, Configured and Recorded without caller assembly",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-constructor-" }),
      );
      const home = join(root, "library");
      const source = join(root, "source");
      const skills = join(root, "skills");
      const bytes = "---\nname: review\ndescription: Constructor fixture\n---\nOriginal skill.\n";
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
      const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Expected an observed local skill");
      const skillId = yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.strictEqual((yield* library.read)._tag, "Absent");
        assert.isFalse(yield* fs.exists(home));
        const imported = yield* library.import.collection(request.value);
        const id = imported.skills[0].skill_id;
        const snapshot = yield* library.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Imported Library is absent");
        const refused = yield* Effect.result(
          library.plan(
            {
              _tag: "Enabled",
              changes: [
                { _tag: "Enable", subject: { _tag: "Skill", id }, where: [{ kind: "global" }] },
              ],
            },
            { base: snapshot },
          ),
        );
        assert.strictEqual(refused._tag, "Failure");
        assert.isFalse(yield* fs.exists(skills));
        return id;
      }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const snapshot = yield* library.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Imported Library is absent");
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Skill", id: skillId },
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: snapshot },
        );
        assert.strictEqual((yield* library.apply(plan)).result._tag, "Applied");
        assert.isTrue(yield* fs.exists(join(skills, "review", "SKILL.md")));
      }).pipe(
        Effect.provide(
          Library.layer({
            home,
            routing: {
              _tag: "Configured",
              home: root,
              configHome: join(root, "config"),
              overrides: { codex: [skills] },
            },
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const snapshot = yield* library.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Enabled Library is absent");
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Disable",
                subject: { _tag: "Skill", id: skillId },
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: snapshot },
        );
        assert.strictEqual((yield* library.apply(plan)).result._tag, "Applied");
        assert.isFalse(yield* fs.exists(join(skills, "review")));
        assert.strictEqual(yield* fs.readFileString(join(source, "SKILL.md")), bytes);
      }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "Recorded" } })));
    }).pipe(Effect.provide(skitLayer)),
);
