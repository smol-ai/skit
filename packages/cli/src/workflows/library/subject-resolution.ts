import type { LibraryState } from "@smolai/skit-core";

type Collection = LibraryState["collections"][number];
type Skill = LibraryState["skills"][number];

export type LibrarySubject =
  | {
      readonly kind: "collection";
      readonly subjectId: Collection["collection_id"];
      readonly label: string;
      readonly collection: Collection;
      readonly skills: readonly Skill[];
    }
  | {
      readonly kind: "skill";
      readonly subjectId: Skill["skill_id"];
      readonly label: string;
      readonly skill: Skill;
      readonly skills: readonly [Skill];
    };

const collectionSubjects = (state: LibraryState): readonly LibrarySubject[] =>
  state.collections.map((collection): LibrarySubject => ({
    kind: "collection",
    subjectId: collection.collection_id,
    label: collection.label,
    collection,
    skills: state.skills.filter((skill) => skill.collection_id === collection.collection_id),
  }));

const skillSubjects = (state: LibraryState): readonly LibrarySubject[] =>
  state.skills.map((skill): LibrarySubject => ({
    kind: "skill",
    subjectId: skill.skill_id,
    label: skill.name,
    skill,
    skills: [skill],
  }));

/** Default commands operate on Collections; contained Skills remain directly addressable. */
export const librarySubjects = (state: LibraryState): readonly LibrarySubject[] =>
  collectionSubjects(state);

export const matchingLibrarySubjects = (
  state: LibraryState,
  query?: string,
): readonly LibrarySubject[] => {
  const subjects = librarySubjects(state);
  if (query === undefined) return subjects;

  const allSubjects = [...collectionSubjects(state), ...skillSubjects(state)];
  const identityMatches = allSubjects.filter(
    (subject) =>
      subject.subjectId === query ||
      (subject.kind === "skill" &&
        subject.skill.versions.some((version) => version.skill_version_id === query)),
  );
  if (identityMatches.length > 0) return identityMatches;

  // Labels shown by `skit list` name top-level subjects. Prefer that visible namespace over a
  // same-named contained Skill, while an otherwise-unmatched member label still selects the Skill
  // itself and never silently widens the operation to its Collection.
  const topLevelLabelMatches = subjects.filter((subject) => subject.label === query);
  if (topLevelLabelMatches.length > 0) return topLevelLabelMatches;

  return skillSubjects(state).filter(
    (subject) => subject.kind === "skill" && subject.label === query,
  );
};

export const subjectAcquisitionIds = (subject: LibrarySubject): ReadonlySet<string> =>
  new Set(
    subject.skills.flatMap((skill) =>
      skill.versions.flatMap((version) => version.origins.map((origin) => origin.acquisition_id)),
    ),
  );

export const owningCollectionSubject = (
  state: LibraryState,
  subject: LibrarySubject,
): LibrarySubject =>
  subject.kind === "collection"
    ? subject
    : (collectionSubjects(state).find(
        (candidate) =>
          candidate.kind === "collection" &&
          candidate.collection.collection_id === subject.skill.collection_id,
      ) ?? subject);

export const latestSubjectAcquisition = (state: LibraryState, subject: LibrarySubject) => {
  const preferred =
    subject.kind === "collection"
      ? subject.collection.upstream?.last_acquisition_id
      : state.collections.find(
          (collection) => collection.collection_id === subject.skill.collection_id,
        )?.upstream?.last_acquisition_id;
  if (preferred !== undefined) {
    const acquisition = state.acquisitions.find(
      (candidate) => candidate.acquisition_id === preferred,
    );
    if (acquisition !== undefined) return acquisition;
  }
  const acquisitionIds = subjectAcquisitionIds(subject);
  return [...state.acquisitions]
    .filter((acquisition) => acquisitionIds.has(acquisition.acquisition_id))
    .sort((a, b) => b.acquired_at.localeCompare(a.acquired_at))[0];
};
