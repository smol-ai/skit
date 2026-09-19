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

export const librarySubjects = (state: LibraryState): readonly LibrarySubject[] => [
  ...state.collections.map((collection): LibrarySubject => ({
    kind: "collection",
    subjectId: collection.collection_id,
    label: collection.label,
    collection,
    skills: state.skills.filter((skill) => skill.collection_id === collection.collection_id),
  })),
  ...state.skills
    .filter((skill) => skill.collection_id === undefined)
    .map((skill): LibrarySubject => ({
      kind: "skill",
      subjectId: skill.skill_id,
      label: skill.name,
      skill,
      skills: [skill],
    })),
];

export const subjectMatches = (subject: LibrarySubject, query: string): boolean =>
  subject.subjectId === query ||
  subject.label === query ||
  subject.skills.some(
    (skill) =>
      skill.skill_id === query ||
      skill.name === query ||
      skill.versions.some((version) => version.skill_version_id === query),
  );

export const matchingLibrarySubjects = (
  state: LibraryState,
  query?: string,
): readonly LibrarySubject[] => {
  const subjects = librarySubjects(state);
  return query === undefined
    ? subjects
    : subjects.filter((subject) => subjectMatches(subject, query));
};

export const subjectAcquisitionIds = (subject: LibrarySubject): ReadonlySet<string> =>
  new Set(
    subject.skills.flatMap((skill) =>
      skill.versions.flatMap((version) => version.origins.map((origin) => origin.acquisition_id)),
    ),
  );

export const latestSubjectAcquisition = (state: LibraryState, subject: LibrarySubject) => {
  const preferred =
    subject.kind === "collection"
      ? subject.collection.upstream?.last_acquisition_id
      : subject.skill.upstream?.last_acquisition_id;
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
