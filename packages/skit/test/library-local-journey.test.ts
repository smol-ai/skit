import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { importCollection } from "../src/library/import-collection.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { planCollectionVersions } from "../src/library/collection-version-plan.js";
import { prepareRestore } from "../src/library/library-restore.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import { readSnapshotArchive } from "../src/library/snapshot-archive.js";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/platform/layer.js";
import { inLibrary, inspectLibrary, saveLibrary } from "./helpers/library-store.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "portable-local-test");

it.effect("retains exact local bytes and restores the portable Library on another device", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-local-" });
    const firstHome = join(workspace, "first");
    const secondHome = join(workspace, "second");
    const installed = join(workspace, "installed", "review");
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.writeFileString(join(installed, "SKILL.md"), "observed locally\n");
    yield* fs.writeFileString(join(installed, "notes.txt"), "retained too\n");

    const imported = yield* Effect.scoped(
      withLibraryWriterLock(
        firstHome,
        importCollection({
          machineId,
          source: { type: "local", path: installed },
          input: installed,
          importedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: installed,
              relativePath: ".",
              currentHash: yield* deterministicTreeHash(installed),
            },
          ],
          lockFileEntries: [],
        }).pipe(inLibrary(firstHome)),
      ),
    );
    const saved = yield* inspectLibrary(firstHome);
    assert.strictEqual(saved.present, true);
    if (!saved.present) return;
    assert.ok(imported.collection?.label.length);
    assert.strictEqual(imported.collection?.upstream, undefined);
    assert.strictEqual(saved.state.imports[0]?.machine_id, machineId);
    assert.strictEqual(saved.state.imports[0]?.input.value, installed);
    const tree = saved.state.collection_versions[0];
    assert.ok(tree);
    const firstOriginal = collectionVersionPath(join(firstHome, "originals"), tree.hash);
    assert.strictEqual(
      yield* fs.readFileString(join(firstOriginal, "notes.txt")),
      "retained too\n",
    );

    const manifest = yield* libraryManifestFromLocalState(saved.state);
    assert.deepStrictEqual(manifest.snapshot_digests, [tree.hash]);
    const archive = yield* readSnapshotArchive(firstOriginal);
    const originalsPath = join(secondHome, "originals");
    const plan = yield* planCollectionVersions(manifest, {
      originalsPath,
      localArchives: [archive],
    });
    const restored = yield* Effect.scoped(prepareRestore(manifest, plan, { originalsPath }));
    yield* saveLibrary(secondHome, restored.state);
    const second = yield* inspectLibrary(secondHome);
    assert.strictEqual(second.present, true);
    if (!second.present) return;
    assert.deepStrictEqual(second.state.imports, saved.state.imports);
    assert.deepStrictEqual(second.state.repositories, []);
    const secondOriginal = collectionVersionPath(join(secondHome, "originals"), tree.hash);
    assert.strictEqual(
      yield* fs.readFileString(join(secondOriginal, "SKILL.md")),
      "observed locally\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reuses an unchanged Skill Version and keeps every import", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-reuse-" });
    const review = join(home, "source", "review");
    const stable = join(home, "source", "stable");
    yield* fs.makeDirectory(review, { recursive: true });
    yield* fs.makeDirectory(stable, { recursive: true });
    yield* fs.writeFileString(join(review, "SKILL.md"), "first\n");
    yield* fs.writeFileString(join(stable, "SKILL.md"), "stable\n");

    const importSource = Effect.fn("Test.retainPair")(function* (importedAt: string) {
      return yield* Effect.scoped(
        withLibraryWriterLock(
          home,
          importCollection({
            machineId,
            source: { type: "github", owner: "fixture", repository: "skills" },
            input: "https://github.com/fixture/skills",
            importedAt,
            skills: [
              {
                name: "review",
                sourcePath: review,
                relativePath: "review",
                currentHash: yield* deterministicTreeHash(review),
              },
              {
                name: "stable",
                sourcePath: stable,
                relativePath: "stable",
                currentHash: yield* deterministicTreeHash(stable),
              },
            ],
            lockFileEntries: [],
          }).pipe(inLibrary(home)),
        ),
      );
    });
    yield* importSource("2026-09-16T01:00:00.000Z");
    const first = yield* inspectLibrary(home);
    assert.strictEqual(first.present, true);
    if (!first.present) return;
    const stableVersion = first.state.skills.find((skill) => skill.name === "stable")?.versions[0];
    yield* fs.writeFileString(join(review, "SKILL.md"), "second\n");
    yield* importSource("2026-09-16T02:00:00.000Z");

    const saved = yield* inspectLibrary(home);
    assert.strictEqual(saved.present, true);
    if (!saved.present) return;
    assert.strictEqual(
      saved.state.skills.find((skill) => skill.name === "review")?.versions.length,
      2,
    );
    assert.deepStrictEqual(saved.state.skills.find((skill) => skill.name === "stable")?.versions, [
      stableVersion,
    ]);
    assert.strictEqual(saved.state.collection_versions.length, 2);
    assert.strictEqual(saved.state.imports.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
