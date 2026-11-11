import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { openLibrary } from "./helpers/library-store.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { skitLayer } from "../src/platform/layer.js";

for (const [name, paths, expected] of [
  ["duplicate names", ["a", "b"], { _tag: "DuplicateSkillName", name: "same", paths: ["a", "b"] }],
  [
    "overlapping paths",
    ["a", "a/b"],
    {
      _tag: "OverlappingSkillPaths",
      skills: [
        { name: "first", path: "a" },
        { name: "second", path: "a/b" },
      ],
    },
  ],
] as const) {
  it.effect(`reports ${name} with the affected paths`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-invalid-import-" });
      const owner = yield* openLibrary(home);
      const error = yield* owner.import
        .collection({
          machineId: makeMachineId(),
          source: { type: "local", path: "/unused" },
          input: "/unused",
          importedAt: "2026-11-05T00:00:00.000Z",
          lockFileEntries: [],
          skills: paths.map((relativePath, index) => ({
            name: name === "duplicate names" ? "same" : index === 0 ? "first" : "second",
            relativePath,
            sourcePath: "/unused",
            currentHash: `sha256:${"a".repeat(64)}`,
          })),
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "Library.ImportRequestInvalid");
      if (error._tag === "Library.ImportRequestInvalid") {
        assert.deepStrictEqual(error.reason, expected);
        assert.strictEqual(error.code, "VALIDATION_FAILED");
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}
