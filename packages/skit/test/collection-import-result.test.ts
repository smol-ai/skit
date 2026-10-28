import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { currentCollectionSkills, currentSkillVersion } from "../src/library/library-contracts.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { importAuthoredCollection, importCollection } from "../src/library/import-collection.js";
import { originalTreeHash, collectionVersionPath } from "../src/library/collection-version.js";
import { LibraryStore, withLibraryWriter } from "../src/library/store/library-store.js";
import { skitLayer } from "../src/platform/layer.js";
import { inLibrary } from "./helpers/library-store.js";

for (const kind of ["observed", "authored"] as const) {
  it.effect(`${kind} import returns a durable result on creation, no-op, and content reuse`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-result-" });
      const home = join(root, "library");
      const source = join(root, "source");
      const memberPath = "skills/review";
      yield* fs.makeDirectory(join(source, memberPath), { recursive: true });
      const bytes = "---\nname: review\ndescription: Review carefully\n---\nReview.\n";
      yield* fs.writeFileString(join(source, memberPath, "SKILL.md"), bytes);
      if (kind === "authored") {
        yield* fs.writeFileString(
          join(source, "skit.json"),
          JSON.stringify({ slug: "tools", skills: [{ name: "review", path: memberPath }] }),
        );
        yield* fs.writeFileString(join(source, "README.md"), "Retain package documentation too.\n");
      }
      const machineId = makeMachineId();
      const importSource = Effect.fn("Test.importWithResult")(function* (
        path: string,
        importedAt: string,
      ) {
        const request = {
          machineId,
          source: { type: "local" as const, path },
          input: path,
          importedAt,
        };
        return yield* Effect.scoped(
          withLibraryWriter(
            kind === "authored"
              ? importAuthoredCollection({ ...request, root: path })
              : importCollection({
                  ...request,
                  skills: [
                    {
                      name: "review",
                      sourcePath: join(path, memberPath),
                      relativePath: memberPath,
                      currentHash: yield* deterministicTreeHash(join(path, memberPath)),
                    },
                  ],
                  observations: [],
                }),
          ).pipe(inLibrary(home)),
        );
      });

      // Preparation has already finalized when the caller consumes this result.
      const imported = yield* importSource(source, "2026-10-16T00:00:00.000Z");
      const store = yield* Effect.service(LibraryStore).pipe(inLibrary(home));
      const state = yield* store.load;
      const copy = state.collection_versions.find(
        (candidate) => candidate.collection_version_id === imported.collectionVersionId,
      );
      assert.ok(copy);
      assert.strictEqual(copy.digest, imported.snapshotDigest);
      assert.strictEqual(state.imports[0]?.collection_version_id, imported.collectionVersionId);
      assert.strictEqual(state.skills[0]?.skill_id, imported.skills[0]?.skill_id);
      const retainedRoot = collectionVersionPath(store.originalsPath, imported.snapshotDigest);
      assert.strictEqual(yield* originalTreeHash(retainedRoot), imported.snapshotDigest);
      const member = imported.members[0];
      assert.ok(member);
      assert.strictEqual(member.name, "review");
      assert.strictEqual(member.sourcePath, memberPath);
      assert.strictEqual(copy.members[0]?.artifact_digest, member.artifactDigest);
      assert.strictEqual(
        yield* originalTreeHash(join(retainedRoot, member.sourcePath)),
        member.sourceDigest,
      );
      assert.strictEqual(
        yield* fs.readFileString(join(retainedRoot, member.sourcePath, "SKILL.md")),
        bytes,
      );
      if (kind === "authored")
        assert.strictEqual(
          yield* fs.readFileString(join(retainedRoot, "README.md")),
          "Retain package documentation too.\n",
        );

      const before = yield* fs.readFileString(join(home, "state.json"));
      const repeated = yield* importSource(source, "2026-10-16T01:00:00.000Z");
      assert.strictEqual(imported.action, "added");
      assert.deepStrictEqual(repeated, { ...imported, action: "unchanged" });
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);

      const otherSource = join(root, "other-source");
      yield* fs.copy(source, otherSource);
      const reused = yield* importSource(otherSource, "2026-10-16T02:00:00.000Z");
      assert.strictEqual(reused.action, "added");
      assert.strictEqual(reused.collectionVersionId, imported.collectionVersionId);
      assert.strictEqual(reused.snapshotDigest, imported.snapshotDigest);
      assert.notStrictEqual(reused.collection.collection_id, imported.collection.collection_id);
      const final = yield* store.load;
      assert.strictEqual(final.collection_versions.length, 1);
      assert.strictEqual(final.collections.length, 2);
      assert.strictEqual(final.imports.length, 2);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

for (const kind of ["observed", "authored"] as const) {
  it.effect(`${kind} outcomes follow current Versions rather than acquisition writes`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-retention-outcomes-" });
      const home = join(root, "library");
      const source = join(root, "source");
      yield* fs.makeDirectory(source);
      const write = (body: string) =>
        fs.writeFileString(
          join(source, "SKILL.md"),
          `---\nname: review\ndescription: Review carefully\n---\n${body}\n`,
        );
      if (kind === "authored")
        yield* fs.writeFileString(
          join(source, "skit.json"),
          JSON.stringify({ slug: "tools", skills: [{ name: "review", path: "." }] }),
        );
      const machineId = makeMachineId();
      let tick = 0;
      const importSource = Effect.fn("Test.retainOutcome")(function* (commit: string) {
        const request = {
          machineId,
          source: { type: "github" as const, owner: "fixture", repository: "skills" },
          input: "https://github.com/fixture/skills",
          revision: { kind: "commit" as const, commit },
          importedAt: new Date(Date.UTC(2026, 9, 22, 0, tick++)).toISOString(),
        };
        return yield* Effect.scoped(
          withLibraryWriter(
            kind === "authored"
              ? importAuthoredCollection({ ...request, root: source })
              : importCollection({
                  ...request,
                  skills: [
                    {
                      name: "review",
                      sourcePath: source,
                      relativePath: ".",
                      currentHash: yield* deterministicTreeHash(source),
                    },
                  ],
                  observations: [],
                }),
          ).pipe(inLibrary(home)),
        );
      });
      const store = yield* Effect.service(LibraryStore).pipe(inLibrary(home));
      yield* write("first");
      const first = yield* importSource("a".repeat(40));
      assert.strictEqual(first.action, "added");
      assert.strictEqual((yield* importSource("a".repeat(40))).action, "unchanged");
      assert.strictEqual((yield* store.load).imports.length, 1);

      // A new upstream revision is recorded even when it contains the same bytes.
      assert.strictEqual((yield* importSource("b".repeat(40))).action, "unchanged");
      assert.strictEqual((yield* store.load).imports.length, 2);
      yield* write("second");
      const changed = yield* importSource("c".repeat(40));
      assert.strictEqual(changed.action, "updated");
      const secondVersion = changed.skills[0]?.versions[1];
      assert.ok(secondVersion);

      // Reverting selects an existing Version; no new Version is created.
      yield* write("first");
      const reverted = yield* importSource("d".repeat(40));
      assert.strictEqual(reverted.action, "updated");
      assert.strictEqual(reverted.skills[0]?.versions.length, 2);
      assert.strictEqual(reverted.collectionVersionId, first.collectionVersionId);

      // A retained local selection survives identical Source bytes, but a Source change clears it.
      yield* Effect.scoped(
        withLibraryWriter(
          Effect.gen(function* () {
            const base = yield* store.load;
            yield* store.save(
              {
                ...base,
                skills: base.skills.map((skill) => ({
                  ...skill,
                  local_version_id: secondVersion.skill_version_id,
                })),
              },
              base,
            );
          }),
        ).pipe(inLibrary(home)),
      );
      const preserved = yield* importSource("e".repeat(40));
      assert.strictEqual(preserved.action, "unchanged");
      assert.strictEqual(preserved.skills[0]?.local_version_id, secondVersion.skill_version_id);
      yield* write("third");
      const replaced = yield* importSource("f".repeat(40));
      assert.strictEqual(replaced.action, "updated");
      assert.strictEqual(replaced.skills[0]?.local_version_id, undefined);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

for (const kind of ["observed", "authored"] as const) {
  for (const change of ["edit-member", "add-member", "remove-member"] as const) {
    it.effect(`${kind} Collection outcome for ${change} preserves unaffected Versions`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-collection-outcome-" });
        const home = join(root, "library");
        const source = join(root, "source");
        const write = Effect.fn("Test.writeCollectionMember")(function* (
          name: string,
          body: string,
        ) {
          const path = join(source, "skills", name);
          yield* fs.makeDirectory(path, { recursive: true });
          yield* fs.writeFileString(
            join(path, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`,
          );
        });
        const machineId = makeMachineId();
        const importSource = Effect.fn("Test.retainCollectionOutcome")(function* (
          names: readonly string[],
        ) {
          if (kind === "authored")
            yield* fs.writeFileString(
              join(source, "skit.json"),
              JSON.stringify({
                slug: "tools",
                skills: names.map((name) => ({ name, path: `skills/${name}` })),
              }),
            );
          const request = {
            machineId,
            source: { type: "local" as const, path: source },
            input: source,
            importedAt: "2026-10-22T00:00:00.000Z",
          };
          return yield* Effect.scoped(
            withLibraryWriter(
              kind === "authored"
                ? importAuthoredCollection({ ...request, root: source })
                : importCollection({
                    ...request,
                    observations: [],
                    skills: yield* Effect.forEach(names, (name) =>
                      Effect.gen(function* () {
                        const path = join(source, "skills", name);
                        return {
                          name,
                          sourcePath: path,
                          relativePath: `skills/${name}`,
                          currentHash: yield* deterministicTreeHash(path),
                        };
                      }),
                    ),
                  }),
            ).pipe(inLibrary(home)),
          );
        });
        yield* write("review", "original review");
        yield* write("plan", "stable plan");
        const initial = yield* importSource(["review", "plan"]);
        assert.strictEqual(initial.action, "added");
        const store = yield* Effect.service(LibraryStore).pipe(inLibrary(home));
        const before = yield* store.load;
        const planBefore = before.skills.find((skill) => skill.name === "plan");
        const reviewBefore = before.skills.find((skill) => skill.name === "review");
        assert.ok(planBefore);
        assert.ok(reviewBefore);
        if (change === "edit-member") yield* write("review", "updated review");
        if (change === "add-member") yield* write("test", "new member");
        if (change === "remove-member")
          yield* fs.remove(join(source, "skills", "review"), { recursive: true });
        const names =
          change === "add-member"
            ? ["review", "plan", "test"]
            : change === "remove-member"
              ? ["plan"]
              : ["review", "plan"];
        const result = yield* importSource(names);
        const after = yield* store.load;
        assert.strictEqual(result.collection.collection_id, initial.collection.collection_id);
        assert.strictEqual(after.collections.length, 1);
        assert.strictEqual(after.imports.length, 2);
        assert.deepStrictEqual(result.skills.map((skill) => skill.name).sort(), [...names].sort());
        assert.deepStrictEqual(
          currentCollectionSkills(after, initial.collection.collection_id)
            .map((skill) => skill.name)
            .sort(),
          [...names].sort(),
        );
        const planAfter = after.skills.find((skill) => skill.skill_id === planBefore.skill_id);
        const reviewAfter = after.skills.find((skill) => skill.skill_id === reviewBefore.skill_id);
        assert.ok(planAfter);
        assert.ok(reviewAfter);
        assert.deepStrictEqual(planAfter, planBefore);
        assert.strictEqual(
          currentSkillVersion(after, planAfter)?.skill_version_id,
          currentSkillVersion(before, planBefore)?.skill_version_id,
        );
        if (change === "edit-member") {
          assert.strictEqual(result.action, "updated");
          assert.strictEqual(reviewAfter.versions.length, reviewBefore.versions.length + 1);
          assert.notStrictEqual(
            currentSkillVersion(after, reviewAfter)?.skill_version_id,
            currentSkillVersion(before, reviewBefore)?.skill_version_id,
          );
        } else if (change === "add-member") {
          assert.strictEqual(result.action, "updated");
          assert.deepStrictEqual(reviewAfter, reviewBefore);
          const added = after.skills.find((skill) => skill.name === "test");
          assert.ok(added);
          assert.strictEqual(added.versions.length, 1);
          assert.ok(currentSkillVersion(after, added));
        } else {
          // A removed upstream member keeps its last Version, but leaves current membership.
          assert.strictEqual(result.action, "unchanged");
          assert.deepStrictEqual(reviewAfter, reviewBefore);
          assert.strictEqual(
            currentSkillVersion(after, reviewAfter)?.skill_version_id,
            currentSkillVersion(before, reviewBefore)?.skill_version_id,
          );
        }
        assert.strictEqual((yield* importSource(names)).action, "unchanged");
        assert.strictEqual((yield* store.load).imports.length, 2);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
  }
}
