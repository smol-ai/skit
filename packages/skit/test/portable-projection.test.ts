import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { TreeHasher, treeHasherLayer } from "../src/artifact/tree-hasher.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { projectPortableBindingEffect } from "../src/library/installation/project-portable.js";
import { retirePortableUnboundGlobalProjectionsEffect } from "../src/library/installation/retire-portable-unbound.js";
import { retainObservedCollectionEffect } from "../src/library/portable-observed-import.js";
import { Digest } from "../src/library/store/state-schema.js";
import { LibraryStore, libraryStoreLayer } from "../src/library/store/library-store.js";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/platform/layer.js";
import { inspectOwnershipMarkerEffect } from "../src/projection/mutation.js";

const machineId = migratedMachineId(
  "019950c0-4c00-7000-8000-000000000001",
  "portable-projection-test",
);

/** A retained local Collection with one Skill globally bound to codex, not yet projected. */
const boundCollection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-project-" });
  const home = join(workspace, "home");
  const source = join(workspace, "source");
  const targetRoot = join(workspace, "harness", "skills");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(targetRoot, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), "raw Skill bytes\n");
  const retained = yield* Effect.scoped(
    withLibraryWriterLock(
      home,
      retainObservedCollectionEffect({
        machineId,
        identity: { profile: "local-collection", version: 1, path: source },
        input: source,
        retainedAt: "2026-09-16T00:00:00.000Z",
        skills: [
          {
            name: "review",
            sourcePath: source,
            relativePath: ".",
            observedHash: yield* deterministicTreeHashEffect(source),
          },
        ],
        observations: [],
      }).pipe(Effect.provide(libraryStoreLayer({ home }))),
    ),
  );
  const storeLayer = libraryStoreLayer({ home });
  const initial = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
    Effect.provide(storeLayer),
  );
  const skillId = retained.skills[0]?.skill_id;
  assert.ok(skillId);
  yield* withLibraryWriterLock(
    home,
    Effect.flatMap(LibraryStore, (store) =>
      store.publish({
        ...initial,
        global_bindings: [
          {
            harness: "codex",
            scope: { kind: "global" },
            skills: [skillId],
          },
        ],
      }),
    ).pipe(Effect.provide(storeLayer)),
  );

  return { fs, home, targetRoot, storeLayer };
});

it.effect(
  "projects bound retained bytes, preserves a foreign target, and retires unbound custody",
  () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, storeLayer } = yield* boundCollection;

      const target = join(targetRoot, "review");
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(join(target, "SKILL.md"), "foreign\n");
      const project = projectPortableBindingEffect({
        harness: "codex",
        root: targetRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer));
      assert.strictEqual(
        Result.isSuccess(yield* withLibraryWriterLock(home, project).pipe(Effect.result)),
        true,
      );
      assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "foreign\n");
      const conflicted = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.strictEqual(conflicted.projections[0]?.status, "conflicted");

      yield* fs.remove(target, { recursive: true });
      yield* withLibraryWriterLock(home, project);
      assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "raw Skill bytes\n");
      assert.strictEqual(yield* fs.exists(join(target, ".skit-ownership.json")), true);
      const installed = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.strictEqual(installed.projections[0]?.status, "installed");
      const markerV2 = yield* inspectOwnershipMarkerEffect(target);
      assert.strictEqual(markerV2.kind, "valid");
      if (markerV2.kind === "valid") assert.strictEqual(markerV2.marker.schemaVersion, 2);

      yield* withLibraryWriterLock(
        home,
        Effect.flatMap(LibraryStore, (store) =>
          store.publish({
            ...installed,
            global_bindings: [],
          }),
        ).pipe(Effect.provide(storeLayer)),
      );
      const retire = retirePortableUnboundGlobalProjectionsEffect({
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer));
      assert.strictEqual(yield* withLibraryWriterLock(home, retire), 1);
      assert.strictEqual(yield* fs.exists(target), false);
      const retired = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.deepStrictEqual(retired.projections, []);
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("publishes nothing when the written Projection does not hash to the retained bytes", () =>
  Effect.gen(function* () {
    const { home, targetRoot, storeLayer } = yield* boundCollection;
    const diverged = Layer.succeed(TreeHasher)({
      hash: () => Effect.succeed(Schema.decodeUnknownSync(Digest)(`sha256:${"0".repeat(64)}`)),
    });
    const projected = yield* withLibraryWriterLock(
      home,
      projectPortableBindingEffect({
        harness: "codex",
        root: targetRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer), Effect.provide(diverged)),
    ).pipe(Effect.result);
    assert.strictEqual(Result.isFailure(projected), true);
    if (Result.isFailure(projected))
      assert.strictEqual(projected.failure._tag, "ProjectionFailure");
    const after = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    assert.deepStrictEqual(after.projections, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
