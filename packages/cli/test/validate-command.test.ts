import { assert, it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { validateCommand } from "../src/handlers/author/validate.js";

it.effect("preserves a malformed Descriptor as its named validation failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-validate-" });
      yield* fs.writeFileString(join(root, "skit.json"), "{");
      const failure = yield* validateCommand(root, "author").pipe(Effect.flip);
      if (failure._tag !== "DescriptorMalformed") return assert.fail(failure._tag);
      assert.strictEqual(failure.format, "json");
    }),
  ).pipe(Effect.provide(skitLayer)),
);
