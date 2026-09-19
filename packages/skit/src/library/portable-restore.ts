import { Effect, Schema } from "effect";
import { join } from "node:path";
import { originalTreeHashEffect, retainLocalTreeEffect } from "./retention/retain-tree.js";
import { materializeVerifiedSnapshotEffect } from "./snapshot-archive.js";
import { verifySnapshotArchiveEffect } from "./snapshot-archive-universal.js";
import { currentLibraryState, LibraryState } from "./portable-local-state.js";
import {
  currentPortableLibraryManifest,
  portableSnapshotDigests,
  type PortableLibraryManifest,
  type SnapshotArchive,
} from "./portable-contracts.js";

export class PortableRestoreInvalid extends Schema.TaggedError<PortableRestoreInvalid>()(
  "Library.PortableRestoreInvalid",
  { detail: Schema.String },
) {}

/** Complete a restore set without treating retrievable source bytes as private snapshots. */
export const completePortableRestoreArchivesEffect = <E, R>(
  manifest: PortableLibraryManifest,
  available: readonly SnapshotArchive[],
  reacquireSource: (digest: string) => Effect.Effect<SnapshotArchive, E, R>,
): Effect.Effect<SnapshotArchive[], E | PortableRestoreInvalid, R> =>
  Effect.gen(function* () {
    const archives = new Map(available.map((archive) => [archive.digest, archive]));
    const snapshotDigests = new Set(manifest.snapshot_digests);
    for (const copy of manifest.retained_copies) {
      if (archives.has(copy.digest)) continue;
      if (snapshotDigests.has(copy.digest))
        return yield* new PortableRestoreInvalid({
          detail: `snapshot-backed retained copy ${copy.digest} not downloaded`,
        });
      const archive = yield* reacquireSource(copy.digest);
      if (archive.digest !== copy.digest)
        return yield* new PortableRestoreInvalid({
          detail: `source-backed retained copy ${copy.digest} returned ${archive.digest}`,
        });
      archives.set(archive.digest, archive);
    }
    return [...archives.values()];
  }).pipe(Effect.withSpan("Library.completePortableRestoreArchives"));

/** Prepare another device without rewriting portable Acquisition provenance. */
export const preparePortableRestoreEffect = Effect.fn("Library.preparePortableRestore")(function* (
  manifest: PortableLibraryManifest,
  archives: readonly SnapshotArchive[],
  originalsPath: string,
) {
  const received = new Map(archives.map((archive) => [archive.digest, archive]));
  for (const tree of manifest.retained_copies) {
    const archive = received.get(tree.digest);
    if (archive === undefined)
      return yield* new PortableRestoreInvalid({
        detail: `retained copy ${tree.digest} not downloaded`,
      });
    const verified = yield* verifySnapshotArchiveEffect(archive);
    const temporary = yield* materializeVerifiedSnapshotEffect(verified);
    const path = yield* retainLocalTreeEffect(temporary, originalsPath, tree.digest, true);
    for (const member of tree.members) {
      const directory = member.source_path === "." ? path : join(path, member.source_path);
      if ((yield* originalTreeHashEffect(directory)) !== member.source_digest)
        return yield* new PortableRestoreInvalid({
          detail: `retained member ${member.source_path} source bytes disagree`,
        });
    }
  }
  const state = yield* LibraryState.makeEffect(
    currentLibraryState({
      collections: [...manifest.collections],
      skills: [...manifest.skills],
      retained_copies: [...manifest.retained_copies],
      acquisitions: [...manifest.acquisitions],
      global_bindings: [...manifest.bindings],
      local_bindings: [],
      projections: [],
      unmanaged: [],
    }),
  ).pipe(
    Effect.mapError(
      () => new PortableRestoreInvalid({ detail: "restored state failed Library validation" }),
    ),
  );
  return { state, projectionDrift: [] as string[] };
});

/** Preview device facts that replacement of portable Library state would strand. */
export function portableMergeCustodyConflicts(
  current: LibraryState,
  manifest: PortableLibraryManifest,
) {
  const skillIds = new Set(manifest.skills.map((item) => item.skill_id));
  const versionIds = new Set(
    manifest.skills.flatMap((skill) => skill.versions.map((version) => version.skill_version_id)),
  );
  const conflicts = [
    ...current.projections.flatMap((projection) =>
      !manifest.bindings.some(
        (binding) =>
          binding.harness === projection.harness && binding.skills.includes(projection.skill_id),
      ) ||
      (skillIds.has(projection.skill_id) && versionIds.has(projection.skill_version_id))
        ? []
        : [`device:${projection.projection_id}:managed-projection`],
    ),
    ...current.local_bindings.flatMap((binding) => {
      return binding.skills.every((skillId) =>
        manifest.skills.some((skill) => skill.skill_id === skillId),
      )
        ? []
        : [`device:${binding.harness}/${binding.scope.root}:repository-binding`];
    }),
  ];
  return [...new Set(conflicts)].sort();
}

/** Keep current device custody while replacing the portable Library fields. */
export const blendPortableRestoredStateEffect = Effect.fn("Library.blendPortableRestoredState")(
  function* (current: LibraryState, restored: LibraryState) {
    const manifest: PortableLibraryManifest = currentPortableLibraryManifest({
      collections: restored.collections,
      skills: restored.skills,
      retained_copies: restored.retained_copies,
      acquisitions: restored.acquisitions,
      snapshot_digests: portableSnapshotDigests(restored),
      bindings: restored.global_bindings.map(
        ({ invocation_policies: _policies, ...binding }) => binding,
      ),
    });
    const custody = portableMergeCustodyConflicts(current, manifest);
    if (custody.length > 0)
      return yield* new PortableRestoreInvalid({ detail: custody.join(", ") });
    const localPolicies = new Map(
      current.global_bindings.map((binding) => [binding.harness, binding.invocation_policies]),
    );
    return yield* LibraryState.makeEffect({
      ...current,
      collections: restored.collections,
      skills: restored.skills,
      retained_copies: restored.retained_copies,
      acquisitions: restored.acquisitions,
      global_bindings: restored.global_bindings.map((binding) => {
        const policies = localPolicies.get(binding.harness);
        return policies === undefined ? binding : { ...binding, invocation_policies: policies };
      }),
    }).pipe(
      Effect.mapError(
        () =>
          new PortableRestoreInvalid({
            detail: "merged Library conflicts with device Bindings or custody",
          }),
      ),
    );
  },
);
