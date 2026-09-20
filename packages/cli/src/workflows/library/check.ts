import {
  LibraryStore,
  originalTreeHashEffect,
  retainedTreePath,
  type LibraryState,
} from "@smolai/skit-core";
import { Effect } from "effect";
import { inspectLibrarySourceEffect, type AddOptions } from "./add.js";
import { checkSkillsShSubjectEffect } from "./skills-sh-update-check.js";
import {
  latestSubjectAcquisition,
  resolveOwningLibrarySubjects,
  subjectAcquisitionIds,
} from "./subject-resolution.js";
import { sourceFromUpstream } from "./upstream-source.js";

export const checkSubjectsEffect = Effect.fn("Library.checkSubjects")(function* (
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
  const subjects = yield* resolveOwningLibrarySubjects(state, query);
  const checked = yield* Effect.forEach(subjects, (subject) =>
    Effect.gen(function* () {
      if (
        subject.kind === "collection" &&
        subject.collection.upstream !== undefined &&
        onCollection !== undefined
      )
        yield* onCollection({
          collection_id: subject.collection.collection_id,
          display_name: subject.collection.label,
        });
      const skills = subject.skills;
      const acquisitionIds = subjectAcquisitionIds(subject);
      const copyIds = new Set(
        state.acquisitions
          .filter((acquisition) => acquisitionIds.has(acquisition.acquisition_id))
          .map((acquisition) => acquisition.retained_copy_id),
      );
      const copies = state.retained_copies.filter((copy) => copyIds.has(copy.retained_copy_id));
      const acquisition = latestSubjectAcquisition(state, subject);
      const currentCopy =
        acquisition === undefined
          ? undefined
          : state.retained_copies.find(
              (copy) => copy.retained_copy_id === acquisition.retained_copy_id,
            );
      const upstream = subject.kind === "collection" ? subject.collection.upstream : undefined;
      const source = upstream === undefined ? undefined : sourceFromUpstream(upstream);
      const inspected =
        source === undefined ? undefined : yield* inspectLibrarySourceEffect(options, source);
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
      const skillsSh = yield* checkSkillsShSubjectEffect(subject, acquisition, currentCopy);
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
        subject_id: subject.subjectId,
        subject_kind: subject.kind,
        label: subject.label,
        retained_copies,
        unresolved_skill_selections: skills.filter(
          (skill) => skill.selected_skill_version_id === undefined,
        ).length,
        source_status:
          upstream === undefined
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
