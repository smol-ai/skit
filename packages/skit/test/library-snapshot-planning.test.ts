import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import {
  acquisitionIsSourceRestorable,
  librarySnapshotDigests,
  SnapshotArchive,
  type Acquisition,
  type LibraryManifest,
  type RetainedCopy,
} from "../src/library/library-contracts.js";
import { LibraryManifestAnyVersion } from "../src/library/library-contracts-v4.js";
import { completeRestoreArchivesEffect } from "../src/library/library-restore.js";

const digest = `sha256:${"a".repeat(64)}`;
const retainedCopyId = makeRetainedCopyId();
const machineId = makeMachineId();
const copy: RetainedCopy = {
  retained_copy_id: retainedCopyId,
  digest,
  copy_profile: "verbatim/v1",
  members: [
    {
      source_path: ".",
      source_digest: digest,
      artifact_digest: digest,
      materialization_profile: "plain-skill/v1",
    },
  ],
};
const collectionId = makeCollectionId();
const acquisition = (overrides: Partial<Acquisition>): Acquisition => ({
  acquisition_id: makeAcquisitionId(),
  collection_id: collectionId,
  kind: "source",
  retained_copy_id: retainedCopyId,
  source_identity: {
    kind: "github",
    owner: "example-org",
    repository: "skills",
    collection_root: ".",
  },
  input: { value: "https://github.com/example-org/skills" },
  revision: "e0219e96214ac420bdb8d15141340625fda63bbb",
  acquired_at: "2026-09-16T00:00:00.000Z",
  machine_id: machineId,
  observations: [],
  ...overrides,
});

it("omits GitHub bytes pinned to a commit from private snapshot planning", () => {
  const pinned = acquisition({});
  assert.strictEqual(acquisitionIsSourceRestorable(pinned), true);
  assert.deepStrictEqual(
    librarySnapshotDigests({ retained_copies: [copy], acquisitions: [pinned] }),
    [],
  );
});

it("restores by revision whatever the collection root or input text", () => {
  for (const restorable of [
    acquisition({
      source_identity: {
        kind: "github",
        owner: "example-org",
        repository: "skills",
        collection_root: "skills",
      },
      input: { value: "https://github.com/example-org/skills/tree/main/skills" },
    }),
    acquisition({
      source_identity: {
        kind: "registry",
        authority: "default",
        namespace: "tim",
        slug: "tools",
      },
      input: { value: "skit:tim/tools" },
      revision: "1.2.0",
    }),
  ])
    assert.strictEqual(acquisitionIsSourceRestorable(restorable), true);
});

it("keeps unpinned, local, and retained-edit acquisitions snapshot-backed", () => {
  const { revision: _revision, ...unpinned } = acquisition({});
  const local = acquisition({
    source_identity: { kind: "local", machine_id: machineId, path: { value: "/tmp/skill" } },
    input: { value: "/tmp/skill" },
  });
  const edit = acquisition({ kind: "retained-edit" });
  for (const item of [unpinned, local, edit])
    assert.strictEqual(acquisitionIsSourceRestorable(item), false);
  assert.deepStrictEqual(
    librarySnapshotDigests({ retained_copies: [copy], acquisitions: [unpinned] }),
    [digest],
  );
  assert.deepStrictEqual(
    librarySnapshotDigests({ retained_copies: [copy, { ...copy }], acquisitions: [local] }),
    [digest],
  );
});

const sourceDigest = `sha256:${"b".repeat(64)}`;
const sourceCopyId = makeRetainedCopyId();
const sourceCopy: RetainedCopy = {
  ...copy,
  retained_copy_id: sourceCopyId,
  digest: sourceDigest,
};
const { revision: _unpinnedRevision, ...unpinnedAcquisition } = acquisition({});
const mixedManifest: LibraryManifest = {
  schema: "skit.library.v6",
  collections: [{ collection_id: collectionId, label: "skills" }],
  skills: [],
  retained_copies: [copy, sourceCopy],
  acquisitions: [unpinnedAcquisition, acquisition({ retained_copy_id: sourceCopyId })],
  snapshot_digests: [digest],
  bindings: [],
};
const snapshotArchive = SnapshotArchive.make({
  profile: "verbatim/v1",
  digest,
  entries: [],
});

it("decodes a v4 manifest into the current model without selections", () => {
  const skillId = makeSkillId();
  const versionId = makeSkillVersionId();
  const legacyAcquisition = {
    acquisition_id: makeAcquisitionId(),
    retained_copy_id: retainedCopyId,
    source_identity: { kind: "url", url: { value: "https://skills.example#skills=review" } },
    tracking: { kind: "default" },
    selection: { kind: "full-tree" },
    input: { value: "wellknown:https://skills.example#skills=review" },
    acquired_at: "2026-09-16T00:00:00.000Z",
    machine_id: machineId,
    observations: [],
  };
  const decoded = Schema.decodeUnknownSync(LibraryManifestAnyVersion)({
    schema: "skit.library.v4",
    collections: [{ collection_id: collectionId, display_name: "review" }],
    skills: [
      {
        skill_id: skillId,
        collection_id: collectionId,
        path: "review",
        name: "review",
        selected_skill_version_id: versionId,
        versions: [
          {
            skill_version_id: versionId,
            source_digest: digest,
            artifact_digest: digest,
            validation_identity_digest: digest,
            materialization_profile: "plain-skill/v1",
            origins: [{ acquisition_id: legacyAcquisition.acquisition_id, source_path: "review" }],
          },
        ],
      },
    ],
    retained_copies: [
      {
        ...copy,
        members: [{ ...copy.members[0]!, source_path: "review" }],
        v3_normalized_tree: {
          digest,
          profile: "legacy/v1",
          source_updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    acquisitions: [legacyAcquisition],
    snapshot_digests: [digest],
    bindings: [],
  });
  assert.strictEqual(decoded.schema, "skit.library.v6");
  assert.strictEqual("v3_normalized_tree" in decoded.retained_copies[0]!, false);
  assert.deepStrictEqual(decoded.acquisitions[0]?.source_identity, {
    kind: "well-known",
    locator: { value: "https://skills.example" },
  });
  assert.strictEqual(decoded.acquisitions[0]?.kind, "source");
  assert.strictEqual(decoded.acquisitions[0]?.collection_id, collectionId);
  assert.deepStrictEqual(decoded.skills[0]?.versions[0]?.skill_version_id, versionId);
});

it("rejects a Skill Version that no Acquisition of its Collection backs", () => {
  const versionId = makeSkillVersionId();
  const otherDigest = `sha256:${"c".repeat(64)}`;
  assert.throws(() =>
    Schema.decodeUnknownSync(LibraryManifestAnyVersion)({
      ...mixedManifest,
      skills: [
        {
          skill_id: makeSkillId(),
          collection_id: collectionId,
          path: ".",
          name: "review",
          versions: [
            {
              skill_version_id: versionId,
              source_digest: otherDigest,
              artifact_digest: otherDigest,
              validation_identity_digest: otherDigest,
              materialization_profile: "plain-skill/v1",
            },
          ],
        },
      ],
    }),
  );
});

it.effect("combines downloaded snapshots with exact source reacquisition", () =>
  Effect.gen(function* () {
    const requested: string[] = [];
    const archives = yield* completeRestoreArchivesEffect(
      mixedManifest,
      [snapshotArchive],
      (requestedDigest) => {
        requested.push(requestedDigest);
        return Effect.succeed(
          SnapshotArchive.make({
            profile: "verbatim/v1",
            digest: sourceDigest,
            entries: [],
          }),
        );
      },
    );
    assert.deepStrictEqual(requested, [sourceDigest]);
    assert.deepStrictEqual(
      archives.map((archive) => archive.digest).sort(),
      [digest, sourceDigest].sort(),
    );
  }),
);

it.effect("rejects changed source bytes before restore preparation", () =>
  Effect.gen(function* () {
    const failure = yield* completeRestoreArchivesEffect(mixedManifest, [snapshotArchive], () =>
      Effect.succeed(snapshotArchive),
    ).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "Library.RestoreInvalid");
    assert.match(failure.detail, /source-backed retained copy.*returned/);
  }),
);

it.effect("fails when the pinned source is unavailable", () =>
  Effect.gen(function* () {
    const failure = yield* completeRestoreArchivesEffect(mixedManifest, [snapshotArchive], () =>
      Effect.fail("source unavailable" as const),
    ).pipe(Effect.flip);
    assert.strictEqual(failure, "source unavailable");
  }),
);

it.effect("does not substitute source reacquisition for a missing private snapshot", () =>
  Effect.gen(function* () {
    let requested = false;
    const failure = yield* completeRestoreArchivesEffect(mixedManifest, [], () => {
      requested = true;
      return Effect.succeed(snapshotArchive);
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "Library.RestoreInvalid");
    assert.match(failure.detail, /snapshot-backed retained copy.*not downloaded/);
    assert.strictEqual(requested, false);
  }),
);
