import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { materializedSkillDigestEffect } from "../src/library/skill-materialization.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("includes declared shared files in Skill Version artifact identity", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-materialization-" });
    const skill = join(root, "skills", "review");
    yield* fs.makeDirectory(skill, { recursive: true });
    yield* fs.writeFileString(join(skill, "SKILL.md"), "review\n");
    yield* fs.writeFileString(join(root, "README.md"), "first\n");
    const plain = yield* Effect.scoped(
      materializedSkillDigestEffect({ retainedRoot: root, sourcePath: "skills/review" }),
    );
    const first = yield* Effect.scoped(
      materializedSkillDigestEffect({
        retainedRoot: root,
        sourcePath: "skills/review",
        shared: [{ from: "README.md", to: "context/README.md" }],
      }),
    );
    yield* fs.writeFileString(join(root, "README.md"), "second\n");
    const second = yield* Effect.scoped(
      materializedSkillDigestEffect({
        retainedRoot: root,
        sourcePath: "skills/review",
        shared: [{ from: "README.md", to: "context/README.md" }],
      }),
    );
    assert.notStrictEqual(first, plain);
    assert.notStrictEqual(second, first);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
