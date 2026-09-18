import { assert, it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { versionCommand } from "../src/handlers/version.js";

it.effect("decodes version metadata through Effect Schema", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-version-" });
      const path = join(root, "package.json");
      yield* fs.writeFileString(path, '{"version":"1.2.3"}');
      assert.strictEqual(yield* versionCommand([path]), "1.2.3");
      yield* fs.writeFileString(path, "{}");
      const failure = yield* versionCommand([path]).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PackageMetadataUnavailable");
    }),
  ).pipe(Effect.provide(skitLayer)),
);
