import { assert, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import {
  canonicalJson,
  currentLibraryManifest,
  librarySnapshotDigests,
  LibraryManifest,
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
  type BindingEntry,
} from "@smolai/skit-core";
import {
  mergeLibraryManifests,
  normalizeLibraryManifest,
} from "../src/workflows/library/library-merge.js";

const machineId = makeMachineId();
/** A fixed pool of one-Skill Collections; every side of a merge is drawn from the same records. */
const pool = Array.from({ length: 4 }, (_, index) => {
  const digest = `sha256:${String(index).repeat(64)}`;
  const collectionId = makeCollectionId();
  const skillId = makeSkillId();
  const retainedCopyId = makeRetainedCopyId();
  return {
    collectionId,
    skillId,
    collection: (label: number) => ({
      collection_id: collectionId,
      label: `pool/${index}/${label}`,
    }),
    skill: {
      skill_id: skillId,
      collection_id: collectionId,
      path: "." as const,
      name: `skill-${index}`,
      versions: [
        {
          skill_version_id: makeSkillVersionId(),
          source_digest: digest,
          artifact_digest: digest,
          validation_identity_digest: digest,
          materialization_profile: "plain-skill/v1" as const,
        },
      ],
    },
    retainedCopy: {
      retained_copy_id: retainedCopyId,
      digest,
      copy_profile: "verbatim/v1" as const,
      members: [
        {
          source_path: "." as const,
          source_digest: digest,
          artifact_digest: digest,
          materialization_profile: "plain-skill/v1" as const,
        },
      ],
    },
    acquisition: {
      acquisition_id: makeAcquisitionId(),
      collection_id: collectionId,
      kind: "source" as const,
      retained_copy_id: retainedCopyId,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: `/tmp/pool-${index}` },
      },
      input: { value: `/tmp/pool-${index}` },
      acquired_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      observations: [],
    },
  };
});

/** Per pool entry: absent, or present with a label variant and a Binding choice. */
const side = Schema.Array(
  Schema.Union([
    Schema.Undefined,
    Schema.Struct({
      label: Schema.Literals([0, 1]),
      binding: Schema.Literals(["none", "skill", "collection"]),
    }),
  ]),
).check(Schema.isBetweenLength(pool.length, pool.length));
type Side = typeof side.Type;

const manifestOf = (choices: Side): LibraryManifest => {
  const present = pool.flatMap((entry, index) => {
    const choice = choices[index];
    return choice === undefined ? [] : [{ entry, choice }];
  });
  const entries = present.flatMap(({ entry, choice }): BindingEntry[] =>
    choice.binding === "skill"
      ? [{ kind: "skill", skill_id: entry.skillId }]
      : choice.binding === "collection"
        ? [{ kind: "collection", collection_id: entry.collectionId }]
        : [],
  );
  const retained_copies = present.map(({ entry }) => entry.retainedCopy);
  const acquisitions = present.map(({ entry }) => entry.acquisition);
  return Schema.decodeUnknownSync(LibraryManifest)(
    currentLibraryManifest({
      collections: present.map(({ entry, choice }) => entry.collection(choice.label)),
      skills: present.map(({ entry }) => entry.skill),
      retained_copies,
      acquisitions,
      snapshot_digests: librarySnapshotDigests({ retained_copies, acquisitions }),
      bindings: entries.length === 0 ? [] : [{ scope: { kind: "global" }, entries }],
    }),
  );
};

const empty = manifestOf(pool.map(() => undefined));
const same = (left: LibraryManifest, right: LibraryManifest) =>
  canonicalJson(normalizeLibraryManifest(left)) === canonicalJson(normalizeLibraryManifest(right));
const collectionIds = (manifest: LibraryManifest) =>
  new Set<string>(manifest.collections.map((item) => item.collection_id));

// Generate only cases within these two laws' conflict-free precondition, including while
// shrinking, rather than counting rejected cases as successful property runs.
const conflictFreeSides = Arbitrary.all([
  Arbitrary.schema(side),
  Arbitrary.schema(side),
  Arbitrary.schema(side),
]).pipe(
  Arbitrary.filter(
    ([base, local, remote]) =>
      mergeLibraryManifests(manifestOf(base), manifestOf(local), manifestOf(remote)).conflicts
        .length === 0,
  ),
);

it.prop("an unchanged side yields the other side", [side, side], ([base, changed]) => {
  const before = manifestOf(base);
  const after = manifestOf(changed);
  for (const merged of [
    mergeLibraryManifests(before, before, after),
    mergeLibraryManifests(before, after, before),
  ]) {
    assert.deepStrictEqual(merged.conflicts, []);
    assert.isTrue(same(merged.manifest, after));
  }
});

it.prop("identical changes on both sides merge to that change", [side, side], ([base, changed]) => {
  const after = manifestOf(changed);
  const merged = mergeLibraryManifests(manifestOf(base), after, after);
  assert.deepStrictEqual(merged.conflicts, []);
  assert.isTrue(same(merged.manifest, after));
});

it.prop(
  "a conflict-free merge is valid and independent of which side is local",
  [conflictFreeSides],
  ([[base, local, remote]]) => {
    const merged = mergeLibraryManifests(manifestOf(base), manifestOf(local), manifestOf(remote));
    assert.isTrue(Schema.is(LibraryManifest)(merged.manifest));
    const swapped = mergeLibraryManifests(manifestOf(base), manifestOf(remote), manifestOf(local));
    assert.deepStrictEqual(swapped.conflicts, []);
    assert.isTrue(same(merged.manifest, swapped.manifest));
  },
);

it.prop(
  "a Collection either side holds is removed only when the base held it",
  [conflictFreeSides],
  ([[base, local, remote]]) => {
    const before = manifestOf(base);
    const mine = manifestOf(local);
    const theirs = manifestOf(remote);
    const merged = mergeLibraryManifests(before, mine, theirs);
    const kept = collectionIds(merged.manifest);
    const held = collectionIds(before);
    for (const collectionId of [...collectionIds(mine), ...collectionIds(theirs)])
      if (!kept.has(collectionId)) assert.isTrue(held.has(collectionId));
  },
);

it.prop("an empty base never removes a Collection", [side, side], ([local, remote]) => {
  const mine = manifestOf(local);
  const theirs = manifestOf(remote);
  const merged = mergeLibraryManifests(empty, mine, theirs);
  const kept = collectionIds(merged.manifest);
  // A record both sides hold differently conflicts; every other record is kept.
  for (const collectionId of [...collectionIds(mine), ...collectionIds(theirs)])
    assert.isTrue(
      kept.has(collectionId) || merged.conflicts.includes(`collection:${collectionId}`),
    );
});

it.prop(
  "concurrent removals and Binding changes never leave an unresolvable merge",
  [side, side, side],
  ([base, local, remote]) => {
    const before = manifestOf(base);
    const mine = manifestOf(local);
    const theirs = manifestOf(remote);
    const merged = mergeLibraryManifests(before, mine, theirs);
    assert.notInclude(merged.conflicts, "manifest:invariants");
    // Taking the remote side of every reported conflict must always yield a valid Library.
    const resolved = mergeLibraryManifests(before, mine, theirs, new Set(merged.conflicts));
    assert.deepStrictEqual(resolved.conflicts, []);
    assert.isTrue(Schema.is(LibraryManifest)(resolved.manifest));
  },
);
