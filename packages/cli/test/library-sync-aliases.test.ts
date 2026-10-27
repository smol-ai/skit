import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import {
  captureSnapshotArchive,
  currentSkillVersion,
  libraryManifestFromLocalState,
  LibraryManifest,
  LibraryState,
  collectionVersionPath,
  type SkillId,
} from "@smolai/skit-core";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { devices } from "./helpers/library-sync-devices.js";

// Every expected identity below is derived by hand from the alias rules in
// docs/library-sync-outcomes.md: an independently added Collection adopts the published identity
// of the same upstream and tracking, its Skills align by path, and Versions align only when their
// source, artifact, validation and materialization facts all match. Nothing here asks the merge
// what it should have produced.

type Homes = Effect.Success<typeof devices>;
type Device = Homes["a"];

const enable = (ids: readonly SkillId[]) => ({
  scope: { kind: "global" as const },
  entries: ids.map((id) => ({ kind: "skill" as const, skill_id: id })),
});
const ids = <T>(records: readonly T[], key: (record: T) => string) => records.map(key).sort();

/**
 * Every reference in the device's state and the remote head resolves, and every digest the device
 * retained before sync (plus every one it now names) is still exact in its originals. Every copy
 * the head names is recoverable from the Registry's snapshots.
 */
const assertIntact = Effect.fn("Test.assertIntact")(function* (
  { server }: Homes,
  device: Device,
  retained: readonly string[],
) {
  const state = yield* device.state;
  assert.isTrue(Schema.is(LibraryState)(state));
  yield* libraryManifestFromLocalState(state);
  const ancestry = state.sync_ancestry;
  if (ancestry !== undefined) assert.isTrue(Schema.is(LibraryManifest)(ancestry.base_manifest));
  for (const digest of new Set([...retained, ...state.retained_copies.map((copy) => copy.digest)]))
    assert.strictEqual(
      (yield* captureSnapshotArchive(collectionVersionPath(join(device.home, "originals"), digest)))
        .digest,
      digest,
    );
  const head = server.remote;
  if (head === null) return;
  assert.isTrue(Schema.is(LibraryManifest)(head.manifest));
  const stored = new Set(server.stored.snapshots.map(([digest]) => digest));
  for (const copy of head.manifest.retained_copies) assert.isTrue(stored.has(copy.digest));
});

const retainedDigests = (device: Device) =>
  Effect.map(device.state, (state) => state.retained_copies.map((copy) => copy.digest));

/** Raw state text, so retired handles are checked without going through the loader. */
const stateBytes = (fs: FileSystem.FileSystem, device: Device) =>
  fs.readFileString(join(device.home, "state.json"));

it.effect(
  "the same upstream under different Collection IDs adopts the published identity and remaps every device reference",
  () =>
    Effect.gen(function* () {
      const homes = yield* devices;
      const { fs, a, b, server } = homes;
      const published = yield* a.retain("same");
      const local = yield* b.retain("same");
      const publishedSkill = published.skills[0]!;
      const localSkill = local.skills[0]!;
      const publishedVersion = publishedSkill.versions[0]!.skill_version_id;
      const localVersion = localSkill.versions[0]!.skill_version_id;
      assert.notStrictEqual(local.collection.collection_id, published.collection.collection_id);
      assert.notStrictEqual(localSkill.skill_id, publishedSkill.skill_id);
      assert.notStrictEqual(localVersion, publishedVersion);
      const repository = join(b.home, "repo");
      yield* b.edit((state) => ({
        ...state,
        global_bindings: [
          {
            ...enable([localSkill.skill_id]),
            invocation_policies: { [localSkill.skill_id]: "explicit" },
          },
        ],
        local_bindings: [
          {
            scope: { kind: "repository", root: repository },
            entries: [{ kind: "collection", collection_id: local.collection.collection_id }],
            invocation_policies: { [localSkill.skill_id]: "implicit" },
          },
        ],
      }));
      yield* b.project();
      const before = yield* b.state;
      const retained = yield* retainedDigests(b);
      const projectionId = before.projections[0]!.projection_id;
      assert.strictEqual((yield* a.sync()).status, "pushed");
      assert.strictEqual((yield* b.sync({ adopt: true })).status, "merged");

      const after = yield* b.state;
      assert.deepStrictEqual(
        ids(after.collections, (item) => item.collection_id),
        [published.collection.collection_id],
      );
      assert.deepStrictEqual(
        ids(after.skills, (item) => item.skill_id),
        [publishedSkill.skill_id],
      );
      // Identical source, artifact and validation facts align to the published Version handle.
      assert.deepStrictEqual(
        ids(after.skills[0]!.versions, (item) => item.skill_version_id),
        [publishedVersion],
      );
      assert.deepStrictEqual(
        ids(after.acquisitions, (item) => item.acquisition_id),
        ids(
          [...(yield* a.state).acquisitions, ...before.acquisitions],
          (item) => item.acquisition_id,
        ),
      );
      for (const acquisition of after.acquisitions)
        assert.strictEqual(acquisition.collection_id, published.collection.collection_id);
      assert.deepStrictEqual(after.global_bindings, [
        {
          ...enable([publishedSkill.skill_id]),
          invocation_policies: { [publishedSkill.skill_id]: "explicit" },
        },
      ]);
      assert.deepStrictEqual(after.local_bindings, [
        {
          scope: { kind: "repository", root: repository },
          entries: [{ kind: "collection", collection_id: published.collection.collection_id }],
          invocation_policies: { [publishedSkill.skill_id]: "implicit" },
        },
      ]);
      const projection = after.projections.find((item) => item.projection_id === projectionId);
      assert.ok(projection);
      assert.strictEqual(projection.skill_id, publishedSkill.skill_id);
      assert.strictEqual(projection.skill_version_id, publishedVersion);
      // The explicit invocation policy is rendered into the installed frontmatter.
      assert.isTrue(
        (yield* fs.readFileString(join(b.root, "same", "SKILL.md"))).endsWith("same\n"),
      );
      // Ancestry anchors the head, which names only the remote identities.
      const head = server.remote!;
      assert.strictEqual(after.sync_ancestry?.revision_id, head.revision_id);
      assert.deepStrictEqual(
        ids(after.sync_ancestry!.base_manifest.collections, (item) => item.collection_id),
        [published.collection.collection_id],
      );
      assert.deepStrictEqual(
        ids(head.manifest.skills, (item) => item.skill_id),
        [publishedSkill.skill_id],
      );
      // No portable or device reference keeps a retired local handle.
      const text = yield* stateBytes(fs, b);
      for (const retired of [local.collection.collection_id, localSkill.skill_id, localVersion])
        assert.notInclude(text, retired);
      yield* assertIntact(homes, b, retained);

      // A gains B's import without another write, then both homes are clean.
      assert.strictEqual(server.writes, 2);
      assert.strictEqual((yield* a.sync()).status, "merged");
      assert.strictEqual((yield* a.state).acquisitions.length, 2);
      assert.strictEqual((yield* b.sync()).status, "clean");
      assert.strictEqual((yield* a.sync()).status, "clean");
      assert.strictEqual(server.writes, 2);
      yield* assertIntact(homes, a, []);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("distinct upstreams with identical bytes keep separate identities", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b, server } = homes;
    const first = yield* a.retain("one", { name: "one", bytes: "shared\n" });
    const second = yield* b.retain("two", { name: "two", bytes: "shared\n" });
    const firstState = yield* a.state;
    const secondState = yield* b.state;
    // The case is only meaningful when the retained bytes really are identical.
    assert.strictEqual(
      firstState.retained_copies[0]!.digest,
      secondState.retained_copies[0]!.digest,
    );
    assert.strictEqual(
      first.skills[0]!.versions[0]!.artifact_digest,
      second.skills[0]!.versions[0]!.artifact_digest,
    );
    const retained = yield* retainedDigests(b);
    assert.strictEqual((yield* a.sync()).status, "pushed");
    assert.strictEqual((yield* b.sync({ adopt: true })).status, "merged");
    assert.strictEqual((yield* a.sync()).status, "merged");
    for (const device of [a, b]) {
      const state = yield* device.state;
      assert.deepStrictEqual(
        ids(state.collections, (item) => item.collection_id),
        [first.collection.collection_id, second.collection.collection_id].sort(),
      );
      assert.deepStrictEqual(
        ids(state.skills, (item) => item.skill_id),
        [first.skills[0]!.skill_id, second.skills[0]!.skill_id].sort(),
      );
      assert.deepStrictEqual(
        ids(
          state.skills.flatMap((skill) => skill.versions),
          (item) => item.skill_version_id,
        ),
        [
          first.skills[0]!.versions[0]!.skill_version_id,
          second.skills[0]!.versions[0]!.skill_version_id,
        ].sort(),
      );
      assert.deepStrictEqual(
        ids(state.retained_copies, (item) => item.retained_copy_id),
        [
          firstState.retained_copies[0]!.retained_copy_id,
          secondState.retained_copies[0]!.retained_copy_id,
        ].sort(),
      );
      yield* assertIntact(homes, device, retained);
    }
    assert.strictEqual((yield* b.sync()).status, "clean");
    assert.strictEqual(server.writes, 2);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// A different source digest over the same artifact needs a declared materialization: forging one
// on a plain Skill is refused by restore verification, so that variant is covered by the merge
// families instead.
it.effect(
  "an equal artifact digest with a different validation digest is a Skill conflict, not an alias",
  () =>
    Effect.gen(function* () {
      const homes = yield* devices;
      const { fs, a, b, server } = homes;
      const initial = yield* a.retain("review", { bytes: "v1\n" });
      const skillId = initial.skills[0]!.skill_id;
      const v1 = initial.skills[0]!.versions[0]!.skill_version_id;
      yield* a.sync();
      assert.strictEqual((yield* b.sync()).status, "pulled");
      const update = { bytes: "v2\n", retainedAt: "2026-01-02T00:00:00.000Z" };
      yield* a.retain("review", update);
      yield* b.retain("review", update);
      const distinct = `sha256:${"e".repeat(64)}`;
      let localV2 = "";
      yield* b.edit((state) => {
        localV2 = state.skills[0]!.versions.find(
          (item) => item.skill_version_id !== v1,
        )!.skill_version_id;
        return {
          ...state,
          skills: state.skills.map((skill) => ({
            ...skill,
            versions: skill.versions.map((item) =>
              item.skill_version_id === localV2
                ? { ...item, validation_identity_digest: distinct }
                : item,
            ),
          })),
        };
      });
      assert.strictEqual((yield* a.sync()).status, "merged");
      const remoteV2 = server.remote!.manifest.skills[0]!.versions.find(
        (item) => item.skill_version_id !== v1,
      )!.skill_version_id;
      const retained = yield* retainedDigests(b);
      const localAcquisitions = ids((yield* b.state).acquisitions, (item) => item.acquisition_id);
      const remoteAcquisitions = ids(
        server.remote!.manifest.acquisitions,
        (item) => item.acquisition_id,
      );

      const unchanged = yield* captureDisk(b.disk);
      const stored = server.stored;
      for (const apply of [false, true]) {
        const stopped = yield* b.sync({ apply });
        assert.strictEqual(stopped.status, "conflicted");
        if (stopped.status === "conflicted")
          assert.deepStrictEqual(stopped.conflicts, [`skill:${skillId}`]);
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.stored, stored);
      }

      assert.strictEqual((yield* b.sync({ takeRemote: [`skill:${skillId}`] })).status, "merged");
      const after = yield* b.state;
      assert.deepStrictEqual(
        ids(after.skills[0]!.versions, (item) => item.skill_version_id),
        [v1, remoteV2].sort(),
      );
      assert.notInclude(yield* stateBytes(fs, b), localV2);
      // The rejected Version's import and bytes stay retained.
      assert.deepStrictEqual(
        ids(after.acquisitions, (item) => item.acquisition_id),
        [...new Set([...localAcquisitions, ...remoteAcquisitions])].sort(),
      );
      assert.strictEqual(after.acquisitions.length, 3);
      yield* assertIntact(homes, b, retained);
      assert.strictEqual((yield* a.sync()).status, "merged");
      assert.strictEqual((yield* b.sync()).status, "clean");
      assert.strictEqual((yield* a.sync()).status, "clean");
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("many independent imports of one upstream converge on one published identity", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b, c, server } = homes;
    const published = yield* a.retain("same");
    yield* b.retain("same");
    yield* c.retain("same");
    const acquisitions = [];
    for (const device of [a, b, c]) acquisitions.push(...(yield* device.state).acquisitions);
    const retained = yield* retainedDigests(c);
    assert.strictEqual((yield* a.sync()).status, "pushed");
    assert.strictEqual((yield* b.sync({ adopt: true })).status, "merged");
    assert.strictEqual((yield* c.sync({ adopt: true })).status, "merged");
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.strictEqual((yield* b.sync()).status, "merged");
    for (const device of [a, b, c]) {
      assert.strictEqual((yield* device.sync()).status, "clean");
      const state = yield* device.state;
      assert.deepStrictEqual(
        ids(state.collections, (item) => item.collection_id),
        [published.collection.collection_id],
      );
      assert.deepStrictEqual(
        ids(state.skills, (item) => item.skill_id),
        [published.skills[0]!.skill_id],
      );
      assert.deepStrictEqual(
        ids(state.skills[0]!.versions, (item) => item.skill_version_id),
        [published.skills[0]!.versions[0]!.skill_version_id],
      );
      assert.deepStrictEqual(
        ids(state.acquisitions, (item) => item.acquisition_id),
        ids(acquisitions, (item) => item.acquisition_id),
      );
      yield* assertIntact(homes, device, retained);
    }
    // Only the first push and each adoption write; every other sync matched the head.
    assert.strictEqual(server.writes, 3);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("an identical retained local edit aligns local_version_id to the published handle", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { fs, a, b, server } = homes;
    const initial = yield* a.retain("review", { bytes: "v1\n" });
    const skillId = initial.skills[0]!.skill_id;
    yield* a.edit((state) => ({ ...state, global_bindings: [enable([skillId])] }));
    yield* a.project();
    yield* a.sync();
    assert.strictEqual((yield* b.sync()).status, "pulled");
    for (const device of [a, b]) {
      const projection = (yield* device.state).projections[0]!;
      yield* fs.writeFileString(join(projection.path, "SKILL.md"), "authored edit\n");
      yield* device.retainProjectionEdit(projection);
    }
    const aEdit = (yield* a.state).skills[0]!.local_version_id;
    const bEdit = (yield* b.state).skills[0]!.local_version_id;
    assert.ok(aEdit);
    assert.ok(bEdit);
    assert.notStrictEqual(aEdit, bEdit);
    const retained = yield* retainedDigests(b);
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.strictEqual((yield* b.sync()).status, "merged");

    const after = yield* b.state;
    const skill = after.skills[0]!;
    assert.strictEqual(skill.local_version_id, aEdit);
    assert.strictEqual(currentSkillVersion(after, skill)?.skill_version_id, aEdit);
    assert.deepStrictEqual(
      ids(skill.versions, (item) => item.skill_version_id),
      ids((yield* a.state).skills[0]!.versions, (item) => item.skill_version_id),
    );
    assert.notInclude(yield* stateBytes(fs, b), bEdit);
    // The source import and both devices' retained edits.
    assert.strictEqual(after.acquisitions.length, 3);
    assert.strictEqual(
      after.acquisitions.filter((item) => item.kind === "retained-edit").length,
      2,
    );
    for (const projection of after.projections)
      assert.include(
        skill.versions.map((item) => item.skill_version_id),
        projection.skill_version_id,
      );
    assert.strictEqual(
      yield* fs.readFileString(join(after.projections[0]!.path, "SKILL.md")),
      "authored edit\n",
    );
    yield* assertIntact(homes, b, retained);
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.strictEqual((yield* a.sync()).status, "clean");
    assert.strictEqual((yield* b.sync()).status, "clean");
    assert.strictEqual(server.writes, 3);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "a divergent independent import is one Collection conflict; taking remote keeps the older local bytes",
  () =>
    Effect.gen(function* () {
      const homes = yield* devices;
      const { fs, a, b, server } = homes;
      const local = yield* b.retain("same", {
        bytes: "local\n",
        retainedAt: "2026-01-01T00:00:00.000Z",
      });
      const published = yield* a.retain("same", {
        bytes: "published\n",
        retainedAt: "2026-01-02T00:00:00.000Z",
      });
      const publishedSkill = published.skills[0]!;
      yield* a.edit((state) => ({
        ...state,
        global_bindings: [enable([publishedSkill.skill_id])],
      }));
      yield* b.edit((state) => ({
        ...state,
        global_bindings: [enable([local.skills[0]!.skill_id])],
      }));
      yield* b.project();
      yield* a.sync();
      const before = yield* b.state;
      const retained = yield* retainedDigests(b);
      const key = `collection:${published.collection.collection_id}`;
      const unchanged = yield* captureDisk(b.disk);
      const stored = server.stored;
      for (const apply of [false, true]) {
        const stopped = yield* b.sync({ adopt: true, apply });
        assert.strictEqual(stopped.status, "conflicted");
        if (stopped.status === "conflicted") {
          // The Skill and import differences belong to the one Collection choice.
          assert.deepStrictEqual(stopped.conflicts, [key]);
          assert.strictEqual(stopped.conflict_details?.[0]?.resolution, "take-remote");
        }
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.stored, stored);
        assert.strictEqual(yield* fs.readFileString(join(b.root, "same", "SKILL.md")), "local\n");
      }

      assert.strictEqual((yield* b.sync({ adopt: true, takeRemote: [key] })).status, "merged");
      const after = yield* b.state;
      assert.deepStrictEqual(
        ids(after.collections, (item) => item.collection_id),
        [published.collection.collection_id],
      );
      assert.deepStrictEqual(
        ids(after.skills, (item) => item.skill_id),
        [publishedSkill.skill_id],
      );
      assert.strictEqual(
        currentSkillVersion(after, after.skills[0]!)?.skill_version_id,
        publishedSkill.versions[0]!.skill_version_id,
      );
      // B's strictly older import stays as history, with its bytes.
      assert.deepStrictEqual(
        ids(after.acquisitions, (item) => item.acquisition_id),
        [
          ...before.acquisitions.map((item) => item.acquisition_id),
          ...(yield* a.state).acquisitions.map((item) => item.acquisition_id),
        ].sort(),
      );
      assert.deepStrictEqual(after.global_bindings, [enable([publishedSkill.skill_id])]);
      assert.strictEqual(yield* fs.readFileString(join(b.root, "same", "SKILL.md")), "published\n");
      yield* assertIntact(homes, b, retained);
      assert.strictEqual((yield* a.sync()).status, "merged");
      assert.strictEqual((yield* b.sync()).status, "clean");
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "a divergent import whose local import is not strictly older cannot be taken remotely",
  () =>
    Effect.gen(function* () {
      const homes = yield* devices;
      const { a, b, server } = homes;
      const published = yield* a.retain("same", { bytes: "published\n" });
      yield* b.retain("same", { bytes: "local\n" });
      yield* a.sync();
      const retained = yield* retainedDigests(b);
      const key = `collection:${published.collection.collection_id}`;
      const unchanged = yield* captureDisk(b.disk);
      const stored = server.stored;
      const stopped = yield* b.sync({ adopt: true, apply: false });
      assert.strictEqual(stopped.status, "conflicted");
      if (stopped.status === "conflicted") {
        assert.deepStrictEqual(stopped.conflicts, [key]);
        // Equal timestamps do not establish precedence, and the local import is unpinned.
        assert.strictEqual(stopped.conflict_details?.[0]?.resolution, "local");
      }
      for (const apply of [false, true])
        assert.strictEqual(
          (yield* b.sync({ adopt: true, apply, takeRemote: [key] })).status,
          "resolution_invalid",
        );
      yield* assertDiskUnchanged(unchanged);
      assert.deepStrictEqual(server.stored, stored);
      yield* assertIntact(homes, b, retained);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
