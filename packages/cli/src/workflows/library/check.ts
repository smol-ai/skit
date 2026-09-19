import {
  LibraryStore,
  originalTreeHashEffect,
  retainedTreePath,
  type LibraryState,
} from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import { acquisitionSourceEffect, inspectLibrarySourceEffect, type AddOptions } from "./add.js";
import { checkSkillsShCollectionEffect } from "./skills-sh-update-check.js";

export class CheckNotFound extends Schema.TaggedError<CheckNotFound>()("Library.CheckNotFound", {
  query: Schema.String,
}) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` to find a retained Collection.";
}
export class CheckAmbiguous extends Schema.TaggedError<CheckAmbiguous>()("Library.CheckAmbiguous", {
  query: Schema.String,
}) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Collection ID to select one Collection.";
}

export const checkCollectionsEffect = Effect.fn("Library.checkCollections")(function* (
  state: LibraryState,
  options: AddOptions,
  query?: string,
  onCollection?: (collection: {
    readonly collection_id: string;
    readonly display_name: string;
  }) => Effect.Effect<void>,
) {
  const store = yield* LibraryStore;
  const baselineUpdates: Array<{
    acquisitionId: string;
    skillName: string;
    skillPath: string;
    hashKind: "computedHash" | "skillFolderHash";
    hash: string;
    commit: string;
    tree: string;
    verification: "lock-only" | "lock+retained-bytes";
    establishedAt: string;
  }> = [];
  const collections =
    query === undefined
      ? state.collections
      : state.collections.filter(
          (collection) =>
            [collection.collection_id, collection.label].includes(query) ||
            state.skills.some(
              (skill) =>
                skill.collection_id === collection.collection_id &&
                (skill.skill_id === query ||
                  skill.name === query ||
                  skill.versions.some((version) => version.skill_version_id === query)),
            ),
        );
  if (query !== undefined && collections.length === 0) return yield* new CheckNotFound({ query });
  if (query !== undefined && collections.length !== 1) return yield* new CheckAmbiguous({ query });
  const checked = yield* Effect.forEach(collections, (collection) =>
    Effect.gen(function* () {
      if (collection.upstream !== undefined && onCollection !== undefined)
        yield* onCollection({
          collection_id: collection.collection_id,
          display_name: collection.label,
        });
      const skills = state.skills.filter(
        (skill) => skill.collection_id === collection.collection_id,
      );
      const acquisitionIds = new Set(
        skills.flatMap((skill) =>
          skill.versions.flatMap((version) =>
            version.origins.map((origin) => origin.acquisition_id),
          ),
        ),
      );
      const copyIds = new Set(
        state.acquisitions
          .filter((acquisition) => acquisitionIds.has(acquisition.acquisition_id))
          .map((acquisition) => acquisition.retained_copy_id),
      );
      const copies = state.retained_copies.filter((copy) => copyIds.has(copy.retained_copy_id));
      const acquisition = state.acquisitions
        .filter((candidate) => acquisitionIds.has(candidate.acquisition_id))
        .reduce<(typeof state.acquisitions)[number] | undefined>(
          (latest, candidate) =>
            latest === undefined || candidate.acquired_at >= latest.acquired_at
              ? candidate
              : latest,
          undefined,
        );
      const currentCopy =
        acquisition === undefined
          ? undefined
          : state.retained_copies.find(
              (copy) => copy.retained_copy_id === acquisition.retained_copy_id,
            );
      const inspected =
        collection.upstream === undefined || acquisition === undefined
          ? undefined
          : yield* inspectLibrarySourceEffect(options, yield* acquisitionSourceEffect(acquisition));
      const retained_copies = [];
      for (const copy of copies) {
        retained_copies.push({
          retained_copy_id: copy.retained_copy_id,
          digest: copy.digest,
          retained_bytes_current:
            (yield* originalTreeHashEffect(retainedTreePath(store.originalsPath, copy.digest))) ===
            copy.digest,
        });
      }
      const skillsSh = yield* checkSkillsShCollectionEffect(
        state,
        collection,
        acquisition,
        currentCopy,
      );
      if (skillsSh && acquisition)
        for (const member of skillsSh.members)
          if (
            member.skill_path &&
            member.hash_kind &&
            member.baseline_commit &&
            member.baseline_tree &&
            member.baseline_verification
          ) {
            const observation = acquisition.observations.find(
              (candidate) =>
                candidate.type === "skills.sh-lock" &&
                candidate.skill_name === member.skill_name &&
                candidate.skill_path === member.skill_path,
            );
            const hash =
              member.hash_kind === "computedHash"
                ? observation?.computed_hash
                : observation?.skill_folder_hash;
            if (hash)
              baselineUpdates.push({
                acquisitionId: acquisition.acquisition_id,
                skillName: member.skill_name,
                skillPath: member.skill_path,
                hashKind: member.hash_kind,
                hash,
                commit: member.baseline_commit,
                tree: member.baseline_tree,
                verification: member.baseline_verification,
                establishedAt: skillsSh.checked_at,
              });
          }
      return {
        collection_id: collection.collection_id,
        display_name: collection.label,
        retained_copies,
        unresolved_skill_selections: skills.filter(
          (skill) => skill.selected_skill_version_id === undefined,
        ).length,
        source_status:
          collection.upstream === undefined
            ? ("not-applicable" as const)
            : inspected === undefined || currentCopy === undefined
              ? ("unverified" as const)
              : inspected.snapshot_digest === currentCopy.digest
                ? ("current" as const)
                : ("changed" as const),
        ...(currentCopy === undefined ? {} : { current_snapshot_digest: currentCopy.digest }),
        ...(inspected === undefined
          ? {}
          : { available_snapshot_digest: inspected.snapshot_digest }),
        acquisition_provenance: state.acquisitions.some((acquisition) =>
          acquisitionIds.has(acquisition.acquisition_id),
        ),
        ...(skillsSh ? { skills_sh: skillsSh } : {}),
      };
    }),
  );
  if (baselineUpdates.length) {
    const acquisitions = state.acquisitions.map((acquisition) => ({
      ...acquisition,
      observations: acquisition.observations.map((observation) => {
        if (observation.type !== "skills.sh-lock") return observation;
        const update = baselineUpdates.find(
          (candidate) =>
            candidate.acquisitionId === acquisition.acquisition_id &&
            candidate.skillName === observation.skill_name &&
            candidate.skillPath === observation.skill_path,
        );
        return update
          ? {
              ...observation,
              upstream_baseline: {
                source_revision: update.commit,
                skill_path: update.skillPath,
                tree_oid: update.tree,
                lock_hash_kind: update.hashKind,
                lock_hash: update.hash,
                verification: update.verification,
                established_at: update.establishedAt,
                search_scope: "ref-path-history" as const,
              },
            }
          : observation;
      }),
    }));
    yield* store.publish({ ...state, acquisitions });
  }
  return checked;
});
