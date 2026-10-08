import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { prepareObservedCollectionEffect } from "../src/library/observed-import.js";
import { skitLayer } from "../src/platform/layer.js";

for (const [name, paths, expected] of [
  ["duplicate names", ["a", "b"], 'duplicate Skill name "same" at "a" and "b"'],
  ["overlapping paths", ["a", "a/b"], 'overlapping Skill paths "a" ("first") and "a/b" ("second")'],
] as const) {
  it.effect(`reports ${name} with the affected paths`, () =>
    Effect.gen(function* () {
      const error = yield* prepareObservedCollectionEffect(
        paths.map((relativePath, index) => ({
          name: name === "duplicate names" ? "same" : index === 0 ? "first" : "second",
          relativePath,
          sourcePath: "/unused",
          observedHash: `sha256:${"a".repeat(64)}`,
        })),
      ).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Library.ObservedImportInvalid");
      if (error._tag === "Library.ObservedImportInvalid") {
        assert.strictEqual(error.message, `Cannot import Collection: ${expected}`);
        assert.strictEqual(error.code, "VALIDATION_FAILED");
      }
    }).pipe(Effect.provide(skitLayer)),
  );
}
