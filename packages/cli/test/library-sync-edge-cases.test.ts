import { assert, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { join } from "node:path";
import {
  currentSkillVersion,
  inspectOwnershipMarkerEffect,
  observeInventory,
  makeAcquisitionId,
  retainedTreePath,
  skitLayer,
  type SkillId,
} from "@smolai/skit-core";
import { LibraryApiUnreachable } from "../src/workflows/library/library-sync-api.js";
import { devices } from "./helpers/library-sync-devices.js";

const enable = (ids: readonly SkillId[]) => ({
  scope: { kind: "global" as const },
  entries: ids.map((id) => ({ kind: "skill" as const, skill_id: id })),
});

it.effect(
  "remote independent Collection choice preserves a retained local edit by rejecting the take",
  () =>
    Effect.gen(function* () {
      const { fs, a, b, remote } = yield* devices;
      const published = yield* a.retain("same");
      const imported = yield* b.retain("same");
      const local = imported.skills[0];
      assert.ok(local);
      yield* b.edit((state) => ({ ...state, global_bindings: [enable([local.skill_id])] }));
      yield* b.project();
      const projection = (yield* b.state).projections[0];
      assert.ok(projection);
      yield* fs.writeFileString(join(projection.path, "SKILL.md"), "authored edit\n");
      yield* b.retainProjectionEdit(projection);
      yield* a.sync();
      const before = yield* b.state;
      const head = yield* remote;
      assert.ok(before.skills[0]?.local_version_id);
      const key = `collection:${published.collection.collection_id}`;
      const preview = yield* b.sync({ adopt: true, apply: false });
      assert.equal(preview.status, "conflicted");
      if (preview.status === "conflicted") {
        assert.include(preview.conflicts, key);
        assert.equal(
          preview.conflict_details?.find((detail) => detail.key === key)?.resolution,
          "local",
        );
      }
      for (const apply of [false, true]) {
        assert.equal(
          (yield* b.sync({ adopt: true, apply, takeRemote: [key] })).status,
          "resolution_invalid",
        );
        assert.deepEqual(yield* b.state, before);
        assert.deepEqual(yield* remote, head);
        assert.equal(
          yield* fs.readFileString(join(projection.path, "SKILL.md")),
          "authored edit\n",
        );
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("same-name Skills from different Sources stop before writes and resolve explicitly", () =>
  Effect.gen(function* () {
    const { fs, a, b, c, remote } = yield* devices;
    const first = yield* a.retain("first", { name: "review" });
    const second = yield* b.retain("second", { name: "review" });
    const unrelated = yield* b.retain("unrelated", { name: "other" });
    const followed = unrelated.collection;
    const firstSkill = first.skills[0];
    const secondSkill = second.skills[0];
    assert.ok(firstSkill);
    assert.ok(secondSkill);
    yield* a.edit((state) => ({ ...state, global_bindings: [enable([firstSkill.skill_id])] }));
    yield* a.project();
    yield* a.sync();
    yield* b.edit((state) => ({
      ...state,
      global_bindings: [
        {
          ...enable([secondSkill.skill_id]),
          entries: [
            { kind: "skill", skill_id: secondSkill.skill_id },
            { kind: "collection", collection_id: followed.collection_id },
          ],
        },
      ],
    }));
    yield* b.project();
    const before = yield* b.state;
    const head = yield* remote;
    const marker = yield* fs.readFileString(join(b.root, "review", ".skit-ownership.json"));
    for (const apply of [false, true]) {
      const stopped = yield* b.sync({ adopt: true, apply });
      assert.equal(stopped.status, "conflicted");
      if (stopped.status === "conflicted")
        assert.isTrue(stopped.conflicts.some((key) => key.endsWith(":collision")));
      assert.deepEqual(yield* b.state, before);
      assert.deepEqual(yield* remote, head);
      assert.equal(
        yield* fs.readFileString(join(b.root, "review", ".skit-ownership.json")),
        marker,
      );
    }
    assert.equal(
      (yield* b.sync({ adopt: true, keepEnabled: [firstSkill.skill_id, secondSkill.skill_id] }))
        .status,
      "resolution_invalid",
    );
    assert.equal(
      (yield* b.sync({ adopt: true, keepEnabled: [secondSkill.skill_id] })).status,
      "merged",
    );
    assert.equal((yield* b.state).skills.length, 3);
    assert.isTrue(
      (yield* b.state).global_bindings[0]?.entries.some(
        (entry) => entry.kind === "collection" && entry.collection_id === followed.collection_id,
      ),
    );
    assert.equal((yield* a.sync()).status, "merged");
    assert.equal(yield* fs.readFileString(join(a.root, "review", "SKILL.md")), "second\n");
    assert.equal((yield* c.sync()).status, "pulled");
    assert.equal((yield* a.sync()).status, "clean");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "independent imports share published identity and keep provenance, policies and native deletion",
  () =>
    Effect.gen(function* () {
      const { fs, a, b, inject, remote } = yield* devices;
      const first = yield* a.retain("same");
      const second = yield* b.retain("same");
      const publishedSkill = first.skills[0];
      const localSkill = second.skills[0];
      assert.ok(publishedSkill);
      assert.ok(localSkill);
      yield* a.edit((state) => ({
        ...state,
        global_bindings: [enable([publishedSkill.skill_id])],
      }));
      yield* b.edit((state) => ({
        ...state,
        global_bindings: [
          {
            ...enable([localSkill.skill_id]),
            invocation_policies: { [localSkill.skill_id]: "explicit" },
          },
        ],
      }));
      yield* a.project();
      yield* b.project();
      yield* a.sync();
      const before = yield* b.state;
      assert.equal((yield* b.sync({ adopt: true, apply: false })).status, "adoption_ready");
      assert.deepEqual(yield* b.state, before);
      inject({ _tag: "DropAfterCommit" });
      assert.ok(Schema.is(LibraryApiUnreachable)(yield* Effect.flip(b.sync({ adopt: true }))));
      assert.deepEqual(yield* b.state, before);
      assert.equal((yield* b.sync({ adopt: true })).status, "merged");
      const after = yield* b.state;
      assert.equal(after.collections.length, 1);
      assert.equal(after.skills.length, 1);
      assert.equal(after.skills[0]?.skill_id, publishedSkill.skill_id);
      assert.equal(after.acquisitions.length, 2);
      assert.equal(after.projections[0]?.projection_id, before.projections[0]?.projection_id);
      assert.ok(after.global_bindings[0]?.invocation_policies?.[publishedSkill.skill_id]);
      const marker = yield* inspectOwnershipMarkerEffect(join(b.root, "same"));
      assert.equal(marker.kind, "valid");
      if (marker.kind === "valid") assert.equal(marker.marker.skill_id, publishedSkill.skill_id);
      yield* fs.remove(join(b.root, "same"), { recursive: true });
      yield* b.edit((state) => ({
        ...state,
        projections: state.projections.map((projection) => ({
          ...projection,
          status: "suppressed",
          suppression_reason: "native_delete",
          suppressed_at: "2026-02-01T00:00:00Z",
        })),
      }));
      assert.equal((yield* b.sync()).status, "clean");
      assert.isFalse(yield* fs.exists(join(b.root, "same")));
      const head = yield* remote;
      assert.ok(head);
      assert.equal(head.manifest.collections.length, 1);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const repository of [false, true]) {
  for (const edited of [false, true]) {
    it.effect(
      `taking remote handles an ${edited ? "edited" : "intact"} ${repository ? "repository" : "global"} projection without disable/re-enable`,
      () =>
        Effect.gen(function* () {
          const { fs, a, b } = yield* devices;
          const initial = yield* a.retain("review");
          const skill = initial.skills[0];
          assert.ok(skill);
          if (!repository)
            yield* a.edit((state) => ({ ...state, global_bindings: [enable([skill.skill_id])] }));
          yield* a.sync();
          yield* b.sync();
          const repositoryScope = { kind: "repository" as const, root: join(b.home, "repo") };
          const scope = repository ? repositoryScope : { kind: "global" as const };
          const root = repository ? join(repositoryScope.root, ".agents", "skills") : b.root;
          if (repository)
            yield* b.edit((state) => ({
              ...state,
              local_bindings: [
                { scope: repositoryScope, entries: [{ kind: "skill", skill_id: skill.skill_id }] },
              ],
            }));
          yield* b.retain("review", { bytes: "B edit\n", retainedAt: "2026-01-02T00:00:00Z" });
          yield* b.project(scope, root);
          if (edited) yield* fs.writeFileString(join(root, "review", "SKILL.md"), "native edit\n");
          yield* a.retain("review", { bytes: "A edit\n", retainedAt: "2026-01-03T00:00:00Z" });
          yield* a.sync();
          const before = yield* b.state;
          assert.equal((yield* b.sync({ apply: false })).status, "conflicted");
          assert.equal(
            (yield* b.sync({ apply: false, takeRemote: [`skill:${skill.skill_id}`] })).status,
            "merge_ready",
          );
          assert.deepEqual(yield* b.state, before);
          assert.equal(
            (yield* b.sync({ takeRemote: [`skill:${skill.skill_id}`] })).status,
            "merged",
          );
          const after = yield* b.state;
          assert.equal(after.projections[0]?.projection_id, before.projections[0]?.projection_id);
          assert.equal(
            after.projections[0]?.skill_version_id,
            currentSkillVersion(after, after.skills[0])?.skill_version_id,
          );
          assert.equal(
            yield* fs.readFileString(join(root, "review", "SKILL.md")),
            edited ? "native edit\n" : "A edit\n",
          );
          if (edited) {
            const projection = after.projections[0];
            assert.ok(projection?.observed_digest);
            assert.equal(projection.status, "conflicted");
            assert.equal(
              yield* fs.readFileString(
                join(
                  b.home,
                  "variants",
                  "agents",
                  "review",
                  projection.observed_digest.slice(7),
                  "SKILL.md",
                ),
              ),
              "native edit\n",
            );
          }
          assert.equal((yield* b.sync()).status, "clean");
        }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
  }
}

it.effect("edited inactive projections remain non-blocking while their references survive", () =>
  Effect.gen(function* () {
    const { fs, a, b } = yield* devices;
    const retained = yield* a.retain("review");
    const skill = retained.skills[0];
    assert.ok(skill);
    yield* a.edit((state) => ({ ...state, global_bindings: [enable([skill.skill_id])] }));
    yield* a.sync();
    yield* b.sync();
    yield* fs.writeFileString(join(b.root, "review", "SKILL.md"), "native edit\n");
    assert.equal((yield* b.sync({ rootFor: () => undefined })).status, "clean");
    assert.equal((yield* b.state).projections[0]?.status, "conflicted");
    assert.equal(yield* fs.readFileString(join(b.root, "review", "SKILL.md")), "native edit\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("nested repository reconciliation retains each repository's own route", () =>
  Effect.gen(function* () {
    const { fs, b } = yield* devices;
    const parent = yield* b.retain("parent");
    const child = yield* b.retain("child");
    const parentSkill = parent.skills[0];
    const childSkill = child.skills[0];
    assert.ok(parentSkill);
    assert.ok(childSkill);
    const parentScope = { kind: "repository" as const, root: join(b.home, "repo") };
    const childScope = { kind: "repository" as const, root: join(parentScope.root, "nested") };
    const parentRoot = join(parentScope.root, ".agents", "skills");
    const childRoot = join(childScope.root, ".agents", "skills");
    yield* b.edit((state) => ({
      ...state,
      local_bindings: [
        { scope: parentScope, entries: [{ kind: "skill", skill_id: parentSkill.skill_id }] },
        { scope: childScope, entries: [{ kind: "skill", skill_id: childSkill.skill_id }] },
      ],
    }));
    yield* b.project(childScope, childRoot);
    yield* b.project(parentScope, parentRoot);
    assert.equal((yield* b.sync()).status, "pushed");
    assert.equal((yield* b.sync()).status, "clean");
    assert.equal(yield* fs.readFileString(join(parentRoot, "parent", "SKILL.md")), "parent\n");
    assert.equal(yield* fs.readFileString(join(childRoot, "child", "SKILL.md")), "child\n");
    assert.isFalse(yield* fs.exists(join(childRoot, "parent")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("incoming repository name collisions stop before either head changes", () =>
  Effect.gen(function* () {
    const { fs, a, b, remote } = yield* devices;
    const first = yield* a.retain("first", { name: "foo" });
    const second = yield* a.retain("second", { name: "bar" });
    yield* a.sync();
    yield* b.sync();
    const scope = { kind: "repository" as const, root: join(b.home, "repo") };
    const root = join(scope.root, ".agents", "skills");
    yield* b.edit((state) => ({
      ...state,
      local_bindings: [
        {
          scope,
          entries: [
            { kind: "collection", collection_id: first.collection.collection_id },
            { kind: "collection", collection_id: second.collection.collection_id },
          ],
        },
      ],
    }));
    yield* b.project(scope, root);
    yield* a.edit((state) => ({
      ...state,
      skills: state.skills.map((skill) =>
        skill.collection_id === second.collection.collection_id ? { ...skill, name: "foo" } : skill,
      ),
    }));
    yield* a.sync();
    const before = yield* b.state;
    const head = yield* remote;
    assert.equal((yield* b.sync()).status, "conflicted");
    assert.deepEqual(yield* b.state, before);
    assert.deepEqual(yield* remote, head);
    assert.equal(yield* fs.readFileString(join(root, "foo", "SKILL.md")), "first\n");
    assert.equal(yield* fs.readFileString(join(root, "bar", "SKILL.md")), "second\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "edited projections block remote removal during preview and apply without changing either head",
  () =>
    Effect.gen(function* () {
      const { fs, a, b, remote } = yield* devices;
      const initial = yield* a.retain("review");
      const skill = initial.skills[0];
      assert.ok(skill);
      yield* a.edit((state) => ({ ...state, global_bindings: [enable([skill.skill_id])] }));
      yield* a.sync();
      yield* b.sync();
      yield* a.remove(initial.collection.collection_id);
      yield* a.sync();
      yield* b.retain("unrelated");
      yield* fs.writeFileString(join(b.root, "review", "SKILL.md"), "native edit\n");
      const before = yield* b.state;
      const head = yield* remote;
      for (const apply of [false, true]) {
        const result = yield* b.sync({ apply });
        assert.equal(result.status, "conflicted");
        if (result.status === "conflicted")
          assert.include(
            result.conflicts,
            `device:${before.projections[0]?.projection_id}:modified-projection`,
          );
        assert.deepEqual(yield* b.state, before);
        assert.deepEqual(yield* remote, head);
        assert.equal(yield* fs.readFileString(join(b.root, "review", "SKILL.md")), "native edit\n");
      }
      yield* fs.writeFileString(join(b.root, "review", "SKILL.md"), "review\n");
      assert.equal((yield* b.sync()).status, "merged");
      assert.isFalse(yield* fs.exists(join(b.root, "review")));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "interrupted identity retirement remains pending across inventory and repairs on retry",
  () =>
    Effect.gen(function* () {
      const { fs, a, b, inject, remote } = yield* devices;
      const first = yield* a.retain("same");
      const second = yield* b.retain("same");
      const firstSkill = first.skills[0];
      const secondSkill = second.skills[0];
      assert.ok(firstSkill);
      assert.ok(secondSkill);
      yield* a.edit((state) => ({ ...state, global_bindings: [enable([firstSkill.skill_id])] }));
      yield* b.edit((state) => ({ ...state, global_bindings: [enable([secondSkill.skill_id])] }));
      yield* b.project();
      yield* a.sync();
      const before = yield* b.state;
      inject({ _tag: "RejectWrite" });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(b.sync({ adopt: true }))));
      assert.deepEqual(yield* b.state, before);
      assert.isTrue(yield* fs.exists(join(b.root, "same")));
      inject({ _tag: "FailPublish", anchoredOnly: true });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(b.sync({ adopt: true }))));
      const interrupted = yield* b.state;
      assert.equal(interrupted.skills[0]?.skill_id, secondSkill.skill_id);
      assert.equal(interrupted.projections[0]?.status, "pending");
      assert.isFalse(yield* fs.exists(join(b.root, "same")));
      const observed = yield* observeInventory(interrupted, []);
      assert.equal(observed.projections[0]?.status, "pending");
      yield* b.edit(() => observed);
      assert.equal((yield* b.sync({ adopt: true })).status, "merged");
      assert.equal((yield* b.state).skills[0]?.skill_id, firstSkill.skill_id);
      assert.equal((yield* b.state).projections[0]?.status, "installed");
      assert.equal(yield* fs.readFileString(join(b.root, "same", "SKILL.md")), "same\n");
      const head = yield* remote;
      assert.ok(head);
      assert.equal(head.manifest.collections.length, 1);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const localBytes of ["B\n", "base\n"]) {
  it.effect(
    `divergent independent Source observations (${localBytes.trim()}) choose a Collection without pinning a local edit`,
    () =>
      Effect.gen(function* () {
        const { fs, a, b } = yield* devices;
        yield* a.retain("same", { bytes: "base\n" });
        yield* b.retain("same", { bytes: "base\n" });
        const remoteUpdate = yield* a.retain("same", {
          bytes: "A\n",
          retainedAt: "2026-01-02T00:00:00Z",
        });
        yield* b.retain("same", { bytes: localBytes, retainedAt: "2026-01-03T00:00:00Z" });
        const localCopies = (yield* b.state).retained_copies;
        yield* a.sync();
        const skill = remoteUpdate.skills[0];
        assert.ok(skill);
        const conflict = yield* b.sync({ adopt: true, apply: false });
        assert.equal(conflict.status, "conflicted");
        if (conflict.status === "conflicted")
          assert.deepEqual(conflict.conflicts, [`collection:${skill.collection_id}`]);
        if (localBytes === "B\n")
          assert.equal(
            (yield* b.sync({ adopt: true, takeRemote: [`collection:${skill.collection_id}`] }))
              .status,
            "resolution_invalid",
          );
        yield* b.edit((state) => ({
          ...state,
          acquisitions: state.acquisitions.map((item) =>
            item.acquired_at === "2026-01-03T00:00:00Z"
              ? { ...item, revision: "b".repeat(40) }
              : item,
          ),
        }));
        assert.equal(
          (yield* b.sync({ adopt: true, takeRemote: [`collection:${skill.collection_id}`] }))
            .status,
          "merged",
        );
        const merged = yield* b.state;
        for (const copy of localCopies) {
          assert.isTrue(yield* fs.exists(retainedTreePath(join(b.home, "originals"), copy.digest)));
        }
        assert.equal(merged.skills[0]?.versions.length, 2);
        assert.equal(merged.skills[0]?.local_version_id, undefined);
        assert.equal(merged.acquisitions.length, 3);
        assert.equal(
          currentSkillVersion(merged, merged.skills[0])?.source_digest,
          remoteUpdate.skills[0]?.versions.at(-1)?.source_digest,
        );
        assert.equal((yield* a.sync()).status, "merged");
        assert.equal((yield* b.sync()).status, "clean");
        const next = yield* b.retain("same", {
          bytes: "next\n",
          retainedAt: "2026-01-04T00:00:00Z",
        });
        const updated = yield* b.state;
        assert.equal(updated.skills[0]?.local_version_id, undefined);
        assert.equal(
          currentSkillVersion(updated, updated.skills[0])?.source_digest,
          next.skills[0]?.versions.at(-1)?.source_digest,
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

it.effect("identity alignment preserves a native deletion recorded before first adoption", () =>
  Effect.gen(function* () {
    const { fs, a, b } = yield* devices;
    const first = yield* a.retain("same");
    const second = yield* b.retain("same");
    const published = first.skills[0];
    const local = second.skills[0];
    assert.ok(published);
    assert.ok(local);
    yield* a.edit((state) => ({ ...state, global_bindings: [enable([published.skill_id])] }));
    yield* b.edit((state) => ({ ...state, global_bindings: [enable([local.skill_id])] }));
    yield* b.project();
    yield* fs.remove(join(b.root, "same"), { recursive: true });
    const deleted = yield* observeInventory(yield* b.state, []);
    yield* b.edit(() => deleted);
    yield* a.sync();
    assert.equal((yield* b.sync({ adopt: true })).status, "merged");
    const after = yield* b.state;
    assert.equal(after.projections[0]?.skill_id, published.skill_id);
    assert.equal(after.projections[0]?.status, "suppressed");
    assert.equal(after.projections[0]?.suppression_reason, "native_delete");
    assert.equal(after.projections[0]?.projection_id, deleted.projections[0]?.projection_id);
    assert.isFalse(yield* fs.exists(join(b.root, "same")));
    assert.equal((yield* b.sync()).status, "clean");
    assert.isFalse(yield* fs.exists(join(b.root, "same")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const remoteDeletes of [false, true]) {
  it.effect(
    `Collection removal versus update resolves as a whole (${remoteDeletes ? "take deletion" : "take update"})`,
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* devices;
        const initial = yield* a.retain("review");
        yield* a.sync();
        yield* b.sync();
        if (remoteDeletes) {
          yield* a.remove(initial.collection.collection_id);
          yield* a.sync();
          yield* b.retain("review", { bytes: "changed\n", retainedAt: "2026-01-02T00:00:00Z" });
        } else {
          yield* b.remove(initial.collection.collection_id);
          yield* a.retain("review", { bytes: "changed\n", retainedAt: "2026-01-02T00:00:00Z" });
          yield* a.sync();
        }
        const key = `collection:${initial.collection.collection_id}`;
        const result = yield* b.sync({ apply: false });
        assert.equal(result.status, "conflicted");
        if (result.status === "conflicted") assert.deepEqual(result.conflicts, [key]);
        assert.equal((yield* b.sync({ takeRemote: [key] })).status, "merged");
        assert.equal((yield* b.state).collections.length, remoteDeletes ? 0 : 1);
        assert.equal((yield* b.sync()).status, "clean");
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

it.effect("destination comparison follows the filesystem's case behavior", () =>
  Effect.gen(function* () {
    const { fs, a, b } = yield* devices;
    const first = yield* a.retain("first", { name: "Review" });
    const second = yield* b.retain("second", { name: "review" });
    const firstSkill = first.skills[0];
    const secondSkill = second.skills[0];
    assert.ok(firstSkill);
    assert.ok(secondSkill);
    yield* a.edit((state) => ({ ...state, global_bindings: [enable([firstSkill.skill_id])] }));
    yield* b.edit((state) => ({ ...state, global_bindings: [enable([secondSkill.skill_id])] }));
    yield* b.project();
    yield* a.sync();
    const folded = yield* fs.exists(join(b.root, "Review"));
    const result = yield* b.sync({ adopt: true, apply: false });
    assert.equal(result.status, folded ? "conflicted" : "adoption_ready");
    if (folded)
      assert.equal(
        (yield* b.sync({ adopt: true, keepEnabled: [secondSkill.skill_id] })).status,
        "merged",
      );
    else assert.equal((yield* b.sync({ adopt: true })).status, "merged");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("aliased projection targets stop even when only one Skill is enabled", () =>
  Effect.gen(function* () {
    const { a, remote } = yield* devices;
    const retained = yield* a.retain("review");
    const skill = retained.skills[0];
    assert.ok(skill);
    yield* a.edit((state) => ({ ...state, global_bindings: [enable([skill.skill_id])] }));
    const before = yield* a.state;
    const result = yield* a.sync({ rootFor: () => a.root });
    assert.equal(result.status, "conflicted");
    assert.deepEqual(yield* a.state, before);
    assert.isNull(yield* remote);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "global and repository destinations compare through symlink aliases before committing",
  () =>
    Effect.gen(function* () {
      const { fs, a, b, remote } = yield* devices;
      const first = yield* a.retain("first", { name: "review" });
      const firstSkill = first.skills[0];
      assert.ok(firstSkill);
      yield* a.sync();
      yield* b.sync();
      const second = yield* b.retain("second", { name: "review" });
      const secondSkill = second.skills[0];
      assert.ok(secondSkill);
      const scope = { kind: "repository" as const, root: join(b.home, "repo") };
      const repositoryRoot = join(scope.root, "skills");
      yield* fs.makeDirectory(scope.root, { recursive: true });
      yield* fs.makeDirectory(b.root, { recursive: true });
      yield* fs.symlink(b.root, repositoryRoot);
      yield* b.edit((state) => ({
        ...state,
        global_bindings: [enable([firstSkill.skill_id])],
        local_bindings: [{ scope, entries: [{ kind: "skill", skill_id: secondSkill.skill_id }] }],
      }));
      yield* b.project(scope, repositoryRoot);
      const before = yield* b.state;
      const head = yield* remote;
      const result = yield* b.sync();
      assert.equal(result.status, "conflicted");
      assert.deepEqual(yield* b.state, before);
      assert.deepEqual(yield* remote, head);
      assert.equal(
        yield* fs.readFileString(join(repositoryRoot, "review", "SKILL.md")),
        "second\n",
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a copy becoming snapshot-backed during merge uploads its already-retained bytes", () =>
  Effect.gen(function* () {
    const { a, b, remote } = yield* devices;
    yield* a.retain("same");
    yield* b.retain("same");
    const extraId = makeAcquisitionId();
    const originalId = (yield* a.state).acquisitions[0]?.acquisition_id;
    assert.ok(originalId);
    yield* a.edit((state) => ({
      ...state,
      acquisitions: [
        ...state.acquisitions.map((acquisition) => ({ ...acquisition, revision: "a".repeat(40) })),
        { ...state.acquisitions[0], acquisition_id: extraId, revision: "b".repeat(40) },
      ],
    }));
    const shared = yield* a.state;
    const copy = shared.retained_copies[0];
    const collection = shared.collections[0];
    assert.ok(copy);
    assert.ok(collection);
    yield* b.edit((state) => ({
      ...state,
      collections: shared.collections,
      skills: shared.skills,
      retained_copies: shared.retained_copies,
      acquisitions: [
        ...shared.acquisitions,
        ...state.acquisitions.map((item) => ({
          ...item,
          collection_id: collection.collection_id,
          retained_copy_id: copy.retained_copy_id,
        })),
      ],
    }));
    yield* a.sync();
    yield* b.sync({ adopt: true });
    yield* a.sync();
    const initialHead = yield* remote;
    assert.ok(initialHead);
    assert.deepEqual(initialHead.manifest.snapshot_digests, []);
    // The CLI currently removes whole Collections; model independent retention changes here.
    yield* a.edit((state) => ({
      ...state,
      acquisitions: state.acquisitions.filter((item) => item.acquisition_id !== extraId),
    }));
    yield* b.edit((state) => ({
      ...state,
      acquisitions: state.acquisitions.filter((item) => item.acquisition_id !== originalId),
    }));
    yield* b.sync();
    assert.equal((yield* a.sync()).status, "merged");
    const head = yield* remote;
    assert.ok(head);
    assert.equal(head.manifest.snapshot_digests.length, 1);
    assert.equal((yield* b.sync()).status, "merged");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
