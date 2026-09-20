import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  makeAcquisitionId,
  makeMachineId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import {
  acquisitionIsSourceRestorable,
  librarySnapshotDigests,
  LibraryManifestAnyVersion,
  SnapshotArchive,
  type Acquisition,
  type LibraryManifest,
  type RetainedCopy,
} from "../src/library/library-contracts.js";
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
const acquisition = (overrides: Partial<Acquisition>): Acquisition => ({
  acquisition_id: makeAcquisitionId(),
  retained_copy_id: retainedCopyId,
  source_identity: {
    kind: "github",
    owner: "example-org",
    repository: "skills",
    collection_root: ".",
  },
  tracking: { kind: "commit", ref: "e0219e96214ac420bdb8d15141340625fda63bbb" },
  selection: { kind: "selected-paths", paths: ["skills/review"] },
  input: { value: "https://github.com/example-org/skills" },
  source_revision: "e0219e96214ac420bdb8d15141340625fda63bbb",
  acquired_at: "2026-09-16T00:00:00.000Z",
  machine_id: machineId,
  observations: [],
  ...overrides,
});

it("omits pinned selected GitHub bytes from private snapshot planning", () => {
  const pinned = acquisition({});
  assert.strictEqual(acquisitionIsSourceRestorable(pinned), true);
  assert.deepStrictEqual(
    librarySnapshotDigests({ retained_copies: [copy], acquisitions: [pinned] }),
    [],
  );
});

it("keeps mutable and local acquisitions snapshot-backed", () => {
  const mutable = acquisition({
    tracking: { kind: "default" },
    source_revision: undefined,
  });
  const local = acquisition({
    source_identity: { kind: "local", machine_id: machineId, path: { value: "/tmp/skill" } },
    tracking: { kind: "default" },
    input: { value: "/tmp/skill" },
    source_revision: undefined,
  });
  assert.strictEqual(acquisitionIsSourceRestorable(mutable), false);
  assert.strictEqual(acquisitionIsSourceRestorable(local), false);
  assert.deepStrictEqual(
    librarySnapshotDigests({ retained_copies: [copy], acquisitions: [mutable] }),
    [digest],
  );
  assert.deepStrictEqual(
    librarySnapshotDigests({ retained_copies: [copy, { ...copy }], acquisitions: [local] }),
    [digest],
  );
});

it("continues to accept legacy pinned whole-repository acquisitions during repair", () => {
  const wholeRepository = acquisition({ selection: { kind: "full-tree" } });
  assert.strictEqual(acquisitionIsSourceRestorable(wholeRepository), true);
  assert.deepStrictEqual(
    librarySnapshotDigests({ retained_copies: [copy], acquisitions: [wholeRepository] }),
    [],
  );
});

const sourceDigest = `sha256:${"b".repeat(64)}`;
const sourceCopyId = makeRetainedCopyId();
const sourceCopy: RetainedCopy = {
  ...copy,
  retained_copy_id: sourceCopyId,
  digest: sourceDigest,
};
const sourceAcquisition = acquisition({
  retained_copy_id: sourceCopyId,
});
const mixedManifest: LibraryManifest = {
  schema: "skit.library.v5",
  collections: [],
  skills: [],
  retained_copies: [copy, sourceCopy],
  acquisitions: [
    acquisition({
      tracking: { kind: "default" },
      source_revision: undefined,
    }),
    sourceAcquisition,
  ],
  snapshot_digests: [digest],
  bindings: [],
};
const snapshotArchive = SnapshotArchive.make({
  profile: "verbatim/v1",
  digest,
  entries: [],
});

it("decodes a v4 portable subset into the current manifest model", () => {
  const { source_revision: _mutableRevision, ...mutableAcquisition } =
    mixedManifest.acquisitions[0]!;
  const { source_revision: _sourceRevision, ...legacySourceAcquisition } = sourceAcquisition;
  const decoded = Schema.decodeUnknownSync(LibraryManifestAnyVersion)({
    ...mixedManifest,
    schema: "skit.library.v4",
    acquisitions: [
      mutableAcquisition,
      {
        ...legacySourceAcquisition,
        source_identity: { kind: "url", url: { value: "https://skills.example#skills=review" } },
        tracking: { kind: "default" },
        selection: { kind: "full-tree" },
        input: { value: "wellknown:https://skills.example#skills=review" },
      },
    ],
    snapshot_digests: [digest, sourceDigest].sort(),
  });
  assert.strictEqual(decoded.schema, "skit.library.v5");
  assert.deepStrictEqual(decoded.acquisitions[1]?.selection, {
    kind: "selected-skills",
    names: ["review"],
  });
  assert.strictEqual(decoded.acquisitions[1]?.input.value, "wellknown:https://skills.example");
});

it("requires an upstream last Acquisition to govern the standalone Skill", () => {
  const origin = acquisition({
    source_identity: { kind: "well-known", locator: { value: "https://skills.example" } },
    tracking: { kind: "default" },
    selection: { kind: "selected-skills", names: ["review"] },
    input: { value: "wellknown:https://skills.example" },
    source_revision: undefined,
  });
  const unrelated = acquisition({
    source_identity: { kind: "well-known", locator: { value: "https://skills.example" } },
    tracking: { kind: "default" },
    selection: { kind: "selected-skills", names: ["review"] },
    input: { value: "wellknown:https://skills.example" },
    source_revision: undefined,
  });
  const skillId = makeSkillId();
  const versionId = makeSkillVersionId();
  assert.throws(() =>
    Schema.decodeUnknownSync(LibraryManifestAnyVersion)({
      schema: "skit.library.v5",
      collections: [],
      skills: [
        {
          skill_id: skillId,
          path: ".",
          name: "review",
          upstream: {
            source_identity: origin.source_identity,
            tracking: origin.tracking,
            selection: origin.selection,
            last_acquisition_id: unrelated.acquisition_id,
          },
          selected_skill_version_id: versionId,
          versions: [
            {
              skill_version_id: versionId,
              source_digest: digest,
              artifact_digest: digest,
              validation_identity_digest: digest,
              materialization_profile: "plain-skill/v1",
              origins: [{ acquisition_id: origin.acquisition_id, source_path: "." }],
            },
          ],
        },
      ],
      retained_copies: [copy],
      acquisitions: [origin, unrelated],
      snapshot_digests: [digest],
      bindings: [],
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
