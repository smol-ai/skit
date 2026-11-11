import { Schema, SchemaIssue } from "effect";

export const LocalStateViolation = Schema.TaggedUnion({
  RepositoryRootCollision: {
    first: Schema.String,
    second: Schema.String,
    canonical: Schema.String,
  },
  InstalledPathCollision: {
    firstId: Schema.String,
    secondId: Schema.String,
    firstPath: Schema.String,
    secondPath: Schema.String,
    canonical: Schema.String,
  },
  InstalledIdDuplicate: { installedSkillId: Schema.String },
  RepositorySubjectMissing: {
    root: Schema.String,
    kind: Schema.Literals(["skill", "collection"]),
    id: Schema.String,
  },
  InstalledSkillMissing: {
    installedSkillId: Schema.String,
    skillId: Schema.String,
    path: Schema.String,
  },
  InstalledVersionMissing: {
    installedSkillId: Schema.String,
    skillId: Schema.String,
    versionId: Schema.String,
    path: Schema.String,
  },
});
export type LocalStateViolation = typeof LocalStateViolation.Type;

export const localStateViolationIssue = (
  path: readonly PropertyKey[],
  violation: LocalStateViolation,
): Schema.FilterIssue => ({
  path,
  issue: new SchemaIssue.Filter(
    Schema.makeFilter(() => false, {
      representation: { id: "skit/schema/library-local-state", payload: violation },
    }),
    new SchemaIssue.InvalidValue(),
  ),
});
