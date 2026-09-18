import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeAcquisitionId, makeMachineId, makeRetainedCopyId } from "../src/library/entity-ids.js";
import {
  portableAcquisitionIsSourceRestorable,
  portableSnapshotDigests,
  SnapshotArchive,
  type PortableAcquisition,
  type PortableLibraryManifest,
  type PortableRetainedCopy,
} from "../src/library/portable-contracts.js";
import { completePortableRestoreArchivesEffect } from "../src/library/portable-restore.js";

const digest = `sha256:${"a".repeat(64)}`;
const retainedCopyId = makeRetainedCopyId();
const machineId = makeMachineId();
const copy: PortableRetainedCopy = {
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
const acquisition = (overrides: Partial<PortableAcquisition>): PortableAcquisition => ({
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
  assert.strictEqual(portableAcquisitionIsSourceRestorable(pinned), true);
  assert.deepStrictEqual(
    portableSnapshotDigests({ retained_copies: [copy], acquisitions: [pinned] }),
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
  assert.strictEqual(portableAcquisitionIsSourceRestorable(mutable), false);
  assert.strictEqual(portableAcquisitionIsSourceRestorable(local), false);
  assert.deepStrictEqual(
    portableSnapshotDigests({ retained_copies: [copy], acquisitions: [mutable] }),
    [digest],
  );
  assert.deepStrictEqual(
    portableSnapshotDigests({ retained_copies: [copy, { ...copy }], acquisitions: [local] }),
    [digest],
  );
});

it("continues to accept legacy pinned whole-repository acquisitions during repair", () => {
  const wholeRepository = acquisition({ selection: { kind: "full-tree" } });
  assert.strictEqual(portableAcquisitionIsSourceRestorable(wholeRepository), true);
  assert.deepStrictEqual(
    portableSnapshotDigests({ retained_copies: [copy], acquisitions: [wholeRepository] }),
    [],
  );
});

const sourceDigest = `sha256:${"b".repeat(64)}`;
const sourceCopyId = makeRetainedCopyId();
const sourceCopy: PortableRetainedCopy = {
  ...copy,
  retained_copy_id: sourceCopyId,
  digest: sourceDigest,
};
const sourceAcquisition = acquisition({
  retained_copy_id: sourceCopyId,
});
const mixedManifest: PortableLibraryManifest = {
  schema: "skit.library.v4",
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

it.effect("combines downloaded snapshots with exact source reacquisition", () =>
  Effect.gen(function* () {
    const requested: string[] = [];
    const archives = yield* completePortableRestoreArchivesEffect(
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
    const failure = yield* completePortableRestoreArchivesEffect(
      mixedManifest,
      [snapshotArchive],
      () => Effect.succeed(snapshotArchive),
    ).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "Library.PortableRestoreInvalid");
    assert.match(failure.detail, /source-backed retained copy.*returned/);
  }),
);

it.effect("fails when the pinned source is unavailable", () =>
  Effect.gen(function* () {
    const failure = yield* completePortableRestoreArchivesEffect(
      mixedManifest,
      [snapshotArchive],
      () => Effect.fail("source unavailable" as const),
    ).pipe(Effect.flip);
    assert.strictEqual(failure, "source unavailable");
  }),
);

it.effect("does not substitute source reacquisition for a missing private snapshot", () =>
  Effect.gen(function* () {
    let requested = false;
    const failure = yield* completePortableRestoreArchivesEffect(mixedManifest, [], () => {
      requested = true;
      return Effect.succeed(snapshotArchive);
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "Library.PortableRestoreInvalid");
    assert.match(failure.detail, /snapshot-backed retained copy.*not downloaded/);
    assert.strictEqual(requested, false);
  }),
);
