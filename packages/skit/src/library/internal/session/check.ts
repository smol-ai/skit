import { Effect } from "effect";
import { dirname } from "node:path";
import { currentSkillVersion, type SkitSource } from "../../library-contracts.js";
import type { LibraryState } from "../../library-state.js";
import type { Hash } from "../../../shared/hash.js";
import { originalTreeHash, collectionVersionPath } from "../../collection-version.js";
import {
  latestSourceImport,
  resolveOwningLibrarySubjects,
  subjectImportIds,
} from "../../subject-resolution.js";
import { checkSkillsShSubject } from "./skills-sh-update-check.js";
import { sourceFromUpstream } from "./upstream-source.js";

export const checkLibrarySubjects = Effect.fn("Library.checkSubjects")(function* <E, R>(
  state: LibraryState,
  originalsPath: string,
  query: string | undefined,
  inspectSource: (source: SkitSource) => Effect.Effect<{ readonly snapshot_digest: Hash }, E, R>,
  onCollection?: (collection: {
    readonly collection_id: string;
    readonly display_name: string;
  }) => Effect.Effect<void>,
) {
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
      const importIds = subjectImportIds(state, subject);
      const copyIds = new Set(
        state.imports
          .filter((sourceImport) => importIds.has(sourceImport.import_id))
          .map((sourceImport) => sourceImport.collection_version_id),
      );
      const copies = state.collection_versions.filter((copy) =>
        copyIds.has(copy.collection_version_id),
      );
      const sourceImport = latestSourceImport(state, subject);
      const currentCopy =
        sourceImport === undefined
          ? undefined
          : state.collection_versions.find(
              (copy) => copy.collection_version_id === sourceImport.collection_version_id,
            );
      const upstream = subject.kind === "collection" ? subject.collection.upstream : undefined;
      const source = upstream === undefined ? undefined : sourceFromUpstream(upstream);
      const inspected = source === undefined ? undefined : yield* inspectSource(source);
      const collection_versions = [];
      for (const copy of copies) {
        collection_versions.push({
          collection_version_id: copy.collection_version_id,
          hash: copy.hash,
          original_intact:
            (yield* originalTreeHash(collectionVersionPath(originalsPath, copy.hash))) ===
            copy.hash,
        });
      }
      const skillsSh = yield* checkSkillsShSubject(
        dirname(originalsPath),
        originalsPath,
        subject,
        sourceImport,
        currentCopy,
      );
      return {
        subject_id: subject.subjectId,
        subject_kind: subject.kind,
        label: subject.label,
        collection_versions,
        unresolved_skill_selections: skills.filter(
          (skill) => currentSkillVersion(state, skill) === undefined,
        ).length,
        source_status:
          upstream === undefined
            ? ("not-applicable" as const)
            : inspected === undefined || currentCopy === undefined
              ? ("unverified" as const)
              : inspected.snapshot_digest === currentCopy.hash
                ? ("current" as const)
                : ("changed" as const),
        ...(currentCopy === undefined ? {} : { current_snapshot_digest: currentCopy.hash }),
        ...(inspected === undefined
          ? {}
          : { available_snapshot_digest: inspected.snapshot_digest }),
        has_imports: state.imports.some((sourceImport) => importIds.has(sourceImport.import_id)),
        ...(skillsSh ? { skills_sh: skillsSh } : {}),
      };
    }),
  );
});
