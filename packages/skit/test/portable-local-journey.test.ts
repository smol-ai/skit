import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { retainObservedCollectionEffect } from "../src/library/portable-observed-import.js";
import { portableManifestFromLocalStateEffect } from "../src/library/portable-local-state.js";
import { preparePortableRestoreEffect } from "../src/library/portable-restore.js";
import { retainedTreePath } from "../src/library/retention/retain-tree.js";
import { captureSnapshotArchiveEffect } from "../src/library/snapshot-archive.js";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/platform/layer.js";
import { inLibrary, inspectLibrary, publishLibrary } from "./helpers/library-store.js";

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

    const retained = yield* Effect.scoped(
      withLibraryWriterLock(
        firstHome,
        retainObservedCollectionEffect({
          machineId,
          identity: { profile: "local-collection", version: 1, path: installed },
          input: installed,
          retainedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: installed,
              relativePath: ".",
              observedHash: yield* deterministicTreeHashEffect(installed),
            },
          ],
          observations: [],
        }).pipe(inLibrary(firstHome)),
      ),
    );
    const saved = yield* inspectLibrary(firstHome);
    assert.strictEqual(saved.present, true);
    if (!saved.present) return;
    assert.ok(retained.collection?.label.length);
    assert.strictEqual(retained.collection?.upstream, undefined);
    assert.strictEqual(saved.state.acquisitions[0]?.machine_id, machineId);
    assert.strictEqual(saved.state.acquisitions[0]?.input.value, installed);
    const tree = saved.state.retained_copies[0];
    assert.ok(tree);
    const firstOriginal = retainedTreePath(join(firstHome, "originals"), tree.digest);
    assert.strictEqual(
      yield* fs.readFileString(join(firstOriginal, "notes.txt")),
      "retained too\n",
    );

    const manifest = yield* portableManifestFromLocalStateEffect(saved.state);
    assert.deepStrictEqual(manifest.snapshot_digests, [tree.digest]);
    const archive = yield* captureSnapshotArchiveEffect(firstOriginal);
    const restored = yield* Effect.scoped(
      preparePortableRestoreEffect(manifest, [archive], join(secondHome, "originals")),
    );
    yield* publishLibrary(secondHome, restored.state);
    const second = yield* inspectLibrary(secondHome);
    assert.strictEqual(second.present, true);
    if (!second.present) return;
    assert.deepStrictEqual(second.state.acquisitions, saved.state.acquisitions);
    assert.deepStrictEqual(second.state.local_bindings, []);
    const secondOriginal = retainedTreePath(join(secondHome, "originals"), tree.digest);
    assert.strictEqual(
      yield* fs.readFileString(join(secondOriginal, "SKILL.md")),
      "observed locally\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reuses an unchanged Skill Version while retaining a changed sibling Version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-reuse-" });
    const review = join(home, "source", "review");
    const stable = join(home, "source", "stable");
    yield* fs.makeDirectory(review, { recursive: true });
    yield* fs.makeDirectory(stable, { recursive: true });
    yield* fs.writeFileString(join(review, "SKILL.md"), "first\n");
    yield* fs.writeFileString(join(stable, "SKILL.md"), "stable\n");

    const retain = Effect.fn("Test.retainPair")(function* (retainedAt: string) {
      return yield* Effect.scoped(
        withLibraryWriterLock(
          home,
          retainObservedCollectionEffect({
            machineId,
            identity: {
              profile: "github-collection",
              version: 1,
              owner: "fixture",
              repository: "skills",
            },
            input: "https://github.com/fixture/skills",
            retainedAt,
            skills: [
              {
                name: "review",
                sourcePath: review,
                relativePath: "review",
                observedHash: yield* deterministicTreeHashEffect(review),
              },
              {
                name: "stable",
                sourcePath: stable,
                relativePath: "stable",
                observedHash: yield* deterministicTreeHashEffect(stable),
              },
            ],
            observations: [],
          }).pipe(inLibrary(home)),
        ),
      );
    });
    yield* retain("2026-09-16T01:00:00.000Z");
    yield* fs.writeFileString(join(review, "SKILL.md"), "second\n");
    yield* retain("2026-09-16T02:00:00.000Z");

    const saved = yield* inspectLibrary(home);
    assert.strictEqual(saved.present, true);
    if (!saved.present) return;
    assert.strictEqual(
      saved.state.skills.find((skill) => skill.name === "review")?.versions.length,
      2,
    );
    assert.strictEqual(
      saved.state.skills.find((skill) => skill.name === "stable")?.versions.length,
      1,
    );
    assert.strictEqual(saved.state.retained_copies.length, 2);
    assert.strictEqual(saved.state.acquisitions.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
