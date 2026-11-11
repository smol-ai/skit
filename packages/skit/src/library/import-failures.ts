import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { Hash } from "../shared/hash.js";
import { SkitValidationDiagnostic } from "../artifact/validation-diagnostic.js";

const member = Schema.Struct({ name: Schema.String, path: Schema.String });
export const ImportRequestInvalidReason = Schema.TaggedUnion({
  EmptyCollection: {},
  UnsafeSkillPath: { skill: Schema.String, path: Schema.String },
  DuplicateSkillName: { name: Schema.String, paths: Schema.Array(Schema.String) },
  OverlappingSkillPaths: { skills: Schema.Array(member) },
  ObservedContentChanged: {
    skill: Schema.String,
    path: Schema.String,
    expected: Hash,
    actual: Hash,
  },
  StateInvalid: {
    kind: Schema.Literals(["library-state", "portable-manifest"]),
    failure: SchemaFailure,
  },
  AuthoredContentInvalid: { diagnostics: Schema.Array(SkitValidationDiagnostic) },
  AuthoredIdentityMissing: { skill: Schema.String },
});
export type ImportRequestInvalidReason = typeof ImportRequestInvalidReason.Type;
export class ImportRequestInvalid
  extends Schema.TaggedError<ImportRequestInvalid, { readonly brand: unique symbol }>()(
    "Library.ImportRequestInvalid",
    { reason: ImportRequestInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}
export class InstalledSkillChanged
  extends Schema.TaggedError<InstalledSkillChanged, { readonly brand: unique symbol }>()(
    "Library.InstalledSkillChanged",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export const ImportFailure = Schema.Union([ImportRequestInvalid, InstalledSkillChanged]);
export type ImportFailure = typeof ImportFailure.Type;
