import {
  currentSkillVersion,
  LibraryStore,
  originalTreeHash,
  retainedTreePath,
  type LibraryState,
} from "@smolai/skit-core";
import { Effect } from "effect";
import { inspectLibrarySource } from "../../library-application/source-acquisition.js";
import { checkSkillsShSubject } from "./skills-sh-update-check.js";
import {
  latestSubjectAcquisition,
  resolveOwningLibrarySubjects,
  subjectAcquisitionIds,
} from "./subject-resolution.js";
import { sourceFromUpstream } from "./upstream-source.js";

export const checkSubjects = Effect.fn("Library.checkSubjects")(function* (
  state: LibraryState,
  query?: string,
  onCollection?: (collection: {
    readonly collection_id: string;
    readonly display_name: string;
  }) => Effect.Effect<void>,
) {
  const store = yield* LibraryStore;
  const subjects = yield* resolveOwningLibrarySubjects(state, query);
  return yield* Effect.forEach(subjects, (subject) =>
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
      const acquisitionIds = subjectAcquisitionIds(state, subject);
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
      const inspected = source === undefined ? undefined : yield* inspectLibrarySource(source);
      const retained_copies = [];
      for (const copy of copies) {
        retained_copies.push({
          retained_copy_id: copy.retained_copy_id,
          digest: copy.digest,
          retained_bytes_current:
            (yield* originalTreeHash(retainedTreePath(store.originalsPath, copy.digest))) ===
            copy.digest,
        });
      }
      const skillsSh = yield* checkSkillsShSubject(subject, acquisition, currentCopy);
      return {
        subject_id: subject.subjectId,
        subject_kind: subject.kind,
        label: subject.label,
        retained_copies,
        unresolved_skill_selections: skills.filter(
          (skill) => currentSkillVersion(state, skill) === undefined,
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
});
