import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { retainObservedCollectionEffect } from "../src/library/observed-import.js";
import { libraryManifestFromLocalStateEffect } from "../src/library/library-state.js";
import { prepareRestoreEffect } from "../src/library/library-restore.js";
import { removeSkillEffect } from "../src/library/installation/remove.js";
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
          source: { type: "local", locator: installed },
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
    const memberSkill = saved.state.skills[0];
    assert.ok(memberSkill);
    const removalFailure = yield* removeSkillEffect({
      skillId: memberSkill.skill_id,
      variantsPath: join(firstHome, "variants"),
    }).pipe(inLibrary(firstHome), Effect.flip);
    assert.strictEqual(removalFailure._tag, "Library.SkillRemovalRequiresCollection");
    const tree = saved.state.retained_copies[0];
    assert.ok(tree);
    const firstOriginal = retainedTreePath(join(firstHome, "originals"), tree.digest);
    assert.strictEqual(
      yield* fs.readFileString(join(firstOriginal, "notes.txt")),
      "retained too\n",
    );

    const manifest = yield* libraryManifestFromLocalStateEffect(saved.state);
    assert.deepStrictEqual(manifest.snapshot_digests, [tree.digest]);
    const archive = yield* captureSnapshotArchiveEffect(firstOriginal);
    const restored = yield* Effect.scoped(
      prepareRestoreEffect(manifest, [archive], join(secondHome, "originals")),
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
            source: { type: "git", locator: "https://github.com/fixture/skills" },
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

    const stableSkill = saved.state.skills.find((skill) => skill.name === "stable");
    assert.ok(stableSkill);
    yield* removeSkillEffect({
      skillId: stableSkill.skill_id,
      variantsPath: join(home, "variants"),
    }).pipe(inLibrary(home));

    const afterRemoval = yield* inspectLibrary(home);
    assert.strictEqual(afterRemoval.present, true);
    if (!afterRemoval.present) return;
    assert.deepStrictEqual(
      afterRemoval.state.skills.map((skill) => skill.name),
      ["review"],
    );
    assert.deepStrictEqual(afterRemoval.state.collections[0]?.upstream?.selection, {
      kind: "selected-paths",
      paths: ["review"],
    });
    assert.strictEqual(afterRemoval.state.collections.length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
