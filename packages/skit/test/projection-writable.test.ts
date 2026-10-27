import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { ProjectionRootNotWritable } from "../src/failures.js";
import { skitLayer } from "../src/platform/layer.js";
import { ensureProjectionRootWritable } from "../src/projection/writable.js";

it.effect("a writable root is created and left without scratch directories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writable-" });
    const root = join(home, ".agents", "skills");

    yield* ensureProjectionRootWritable(root);

    assert.deepStrictEqual(yield* fs.readDirectory(root), []);
    assert.deepStrictEqual(yield* fs.readDirectory(join(home, ".agents")), ["skills"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a root under a read-only directory fails naming the root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writable-" });
    const parent = join(home, ".agents");
    yield* fs.makeDirectory(parent);
    yield* fs.chmod(parent, 0o500);
    yield* Effect.addFinalizer(() => Effect.orDie(fs.chmod(parent, 0o700)));
    const root = join(parent, "skills");

    const error = yield* Effect.flip(ensureProjectionRootWritable(root));

    assert.instanceOf(error, ProjectionRootNotWritable);
    assert.strictEqual(error.root, root);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
