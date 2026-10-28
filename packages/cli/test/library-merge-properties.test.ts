import { assert, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import {
  canonicalJson,
  currentLibraryManifest,
  librarySnapshotDigests,
  LibraryManifest,
  makeImportId,
  makeCollectionId,
  makeMachineId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
  type Enabled,
} from "@smolai/skit-core";
import {
  mergeLibraryManifests,
  normalizeLibraryManifest,
} from "../src/workflows/library/library-merge.js";

const machineId = makeMachineId();
/** A fixed pool of one-Skill Collections; every side of a merge is drawn from the same records. */
const pool = Array.from({ length: 4 }, (_, index) => {
  const hash = `sha256:${String(index).repeat(64)}`;
  const collectionId = makeCollectionId();
  const skillId = makeSkillId();
  const collectionVersionId = makeCollectionVersionId();
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
          source_hash: hash,
          artifact_hash: hash,
          validation_identity_hash: hash,
          materialization_profile: "plain-skill/v1" as const,
        },
      ],
    },
    collectionVersion: {
      collection_version_id: collectionVersionId,
      hash: hash,
      copy_profile: "verbatim/v1" as const,
      members: [
        {
          source_path: "." as const,
          source_hash: hash,
          artifact_hash: hash,
          materialization_profile: "plain-skill/v1" as const,
        },
      ],
    },
    sourceImport: {
      import_id: makeImportId(),
      collection_id: collectionId,
      kind: "source" as const,
      collection_version_id: collectionVersionId,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: `/tmp/pool-${index}` },
      },
      input: { value: `/tmp/pool-${index}` },
      imported_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      lock_file_entries: [],
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
  const entries = present.flatMap(({ entry, choice }): Enabled[] =>
    choice.binding === "skill"
      ? [{ skill: entry.skillId }]
      : choice.binding === "collection"
        ? [{ collection: entry.collectionId }]
        : [],
  );
  const retained_copies = present.map(({ entry }) => entry.collectionVersion);
  const imports = present.map(({ entry }) => entry.sourceImport);
  return Schema.decodeUnknownSync(LibraryManifest)(
    currentLibraryManifest({
      collections: present.map(({ entry, choice }) => entry.collection(choice.label)),
      skills: present.map(({ entry }) => entry.skill),
      collection_versions: retained_copies,
      imports: imports,
      snapshot_digests: librarySnapshotDigests({
        collection_versions: retained_copies,
        imports: imports,
      }),
      enabled: entries,
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
