import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { currentCollectionSkills, currentSkillVersion } from "../src/library/library-contracts.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { retainObservedCollectionEffect } from "../src/library/observed-import.js";
import { LibraryStore, libraryStoreLayer } from "../src/library/store/library-store.js";
import { skitLayer } from "../src/platform/layer.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "moved-skill-test");

it.effect("keeps a moved Skill's old row and retained Version beside its new path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-moved-skill-" });
    const source = join(workspace, "source");
    const home = join(workspace, "home");
    const skillAt = (relativePath: string) =>
      Effect.gen(function* () {
        const path = join(source, relativePath);
        yield* fs.makeDirectory(path, { recursive: true });
        yield* fs.writeFileString(join(path, "SKILL.md"), "---\nname: spec\ndescription: d\n---\n");
        return {
          name: "spec",
          sourcePath: path,
          relativePath,
          observedHash: yield* deterministicTreeHashEffect(path),
        };
      });
    const retain = (skills: Parameters<typeof retainObservedCollectionEffect>[0]["skills"]) =>
      retainObservedCollectionEffect({
        machineId,
        source: { type: "local", path: source },
        input: source,
        retainedAt: "2026-09-17T00:00:00.000Z",
        skills,
        observations: [],
      }).pipe(Effect.scoped, Effect.provide(libraryStoreLayer({ home })));

    const before = yield* retain([yield* skillAt("in-progress/spec")]);
    yield* fs.remove(join(source, "in-progress"), { recursive: true });
    const after = yield* retain([yield* skillAt("engineering/spec")]);

    const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.deepStrictEqual(
      state.skills.map((skill) => [skill.name, skill.path]),
      [
        ["spec", "in-progress/spec"],
        ["spec", "engineering/spec"],
      ],
    );
    assert.strictEqual(after.skills[0]!.skill_id !== before.skills[0]!.skill_id, true);
    assert.deepStrictEqual(
      currentCollectionSkills(state, after.collection.collection_id).map((skill) => skill.path),
      ["engineering/spec"],
    );
    // The retired row keeps the Version its own path observed.
    assert.strictEqual(
      currentSkillVersion(state, state.skills[0]!)?.skill_version_id !== undefined,
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
