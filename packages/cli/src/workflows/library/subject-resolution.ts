import { sourceAcquisitions, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";

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

export class LibrarySubjectNotFound extends Schema.TaggedError<LibrarySubjectNotFound>()(
  "Library.SubjectNotFound",
  { query: Schema.String },
) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` to find a retained Skill or Collection.";
  get message(): string {
    return `No retained Skill or Collection matches ${this.query}`;
  }
}

export class LibrarySubjectAmbiguous extends Schema.TaggedError<LibrarySubjectAmbiguous>()(
  "Library.SubjectAmbiguous",
  { query: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Skill or Collection ID to select one subject.";
  get message(): string {
    return `More than one retained Skill or Collection matches ${this.query}`;
  }
}

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

export const resolveLibrarySubject = Effect.fn("Library.resolveSubject")(function* (
  state: LibraryState,
  query: string,
) {
  const matches = matchingLibrarySubjects(state, query);
  if (matches.length === 0) return yield* new LibrarySubjectNotFound({ query });
  if (matches.length !== 1) return yield* new LibrarySubjectAmbiguous({ query });
  const subject = matches[0];
  if (subject === undefined) return yield* new LibrarySubjectNotFound({ query });
  return subject;
});

/** The Collection a subject belongs to. */
const subjectCollectionId = (subject: LibrarySubject) =>
  subject.kind === "collection" ? subject.collection.collection_id : subject.skill.collection_id;

export const subjectAcquisitionIds = (
  state: LibraryState,
  subject: LibrarySubject,
): ReadonlySet<string> =>
  new Set(
    state.acquisitions
      .filter((acquisition) => acquisition.collection_id === subjectCollectionId(subject))
      .map((acquisition) => acquisition.acquisition_id),
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

const uniqueSubjects = (subjects: readonly LibrarySubject[]): readonly LibrarySubject[] => [
  ...new Map(subjects.map((subject) => [subject.subjectId, subject])).values(),
];

/** Default to all top-level Collections; a query may address a member and widen to its owner. */
export const resolveOwningLibrarySubjects = Effect.fn("Library.resolveOwningSubjects")(function* (
  state: LibraryState,
  query?: string,
) {
  if (query === undefined) return librarySubjects(state);
  return uniqueSubjects([
    owningCollectionSubject(state, yield* resolveLibrarySubject(state, query)),
  ]);
});

/** The subject's Collection's latest Source Acquisition. */
export const latestSubjectAcquisition = (state: LibraryState, subject: LibrarySubject) =>
  sourceAcquisitions(state, subjectCollectionId(subject))[0];
