import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { Hash } from "../shared/hash.js";

export const SetupManageSelectionReason = Schema.Literals([
  "duplicate-selection",
  "candidate-not-found",
  "candidate-not-manageable",
  "candidate-not-bindable",
  "source-not-candidate",
  "content-identity-missing",
  "path-not-projection-target",
  "duplicate-action-required",
  "keep-both-replaces-link",
  "aliases-not-retirable",
  "copies-not-preservable",
]);

export class SetupPlanStale
  extends Schema.TaggedError<SetupPlanStale, { readonly brand: unique symbol }>()(
    "SetupPlanStale",
    { approvedPlanId: Hash, currentPlanId: Hash },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class SetupManageSelectionInvalid
  extends Schema.TaggedError<SetupManageSelectionInvalid, { readonly brand: unique symbol }>()(
    "SetupManageSelectionInvalid",
    { skillName: Schema.String, reason: SetupManageSelectionReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class SetupDuplicateDecisionRequired
  extends Schema.TaggedError<SetupDuplicateDecisionRequired, { readonly brand: unique symbol }>()(
    "SetupDuplicateDecisionRequired",
    { names: Schema.Array(Schema.String), retirable: Schema.Boolean, keepBoth: Schema.Boolean },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

/** Rejected review input, with the observation or selection that made it invalid. */
export const SetupReviewInputReason = Schema.TaggedUnion({
  ActionUnavailable: { value: Schema.String },
  DuplicateVersionChoices: { skillIds: Schema.Array(Schema.String) },
  VersionUnavailable: {
    skillId: Schema.String,
    version: Schema.Literals(["retained", "local"]),
    path: Schema.optionalKey(Schema.String),
  },
  DecisionCountMismatch: { selected: Schema.Number, decisions: Schema.Number },
  CopyDecisionCountMismatch: { name: Schema.String, path: Schema.String, decisions: Schema.Number },
  KeepBothReplacesLink: { name: Schema.String, path: Schema.String },
  CopiesNotPreservable: { name: Schema.String, path: Schema.String, conflict: Schema.String },
  AliasesNotRetirable: { name: Schema.String, path: Schema.String, conflict: Schema.String },
  SourceUnavailable: { key: Schema.String },
  RecommendedCopyMissing: { name: Schema.String, path: Schema.String },
  ExistingSkillUnavailable: { skillId: Schema.String },
  SourceIdUnavailable: { sourceId: Schema.String },
  CopyUnavailable: { path: Schema.String },
  RemovalUnavailable: { path: Schema.String },
  RemovalAlsoEnabled: { path: Schema.String },
  ComparisonCopyUnavailable: { path: Schema.String },
  ComparisonEmpty: {},
  ComparisonIdentityMissing: { path: Schema.String },
  ComparisonContentChanged: { path: Schema.String, expected: Hash, actual: Hash },
  LibraryVersionUnavailable: { skillId: Schema.String },
  CurrentVersionUnavailable: { path: Schema.String },
});
export type SetupReviewInputReason = typeof SetupReviewInputReason.Type;

export class SetupReviewInputInvalid
  extends Schema.TaggedError<SetupReviewInputInvalid, { readonly brand: unique symbol }>()(
    "SetupReviewInputInvalid",
    { reason: SetupReviewInputReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

/** An older pending update lacks the selection approval needed to replay it safely. */
export class UpdateSelectionMissing
  extends Schema.TaggedError<UpdateSelectionMissing, { readonly brand: unique symbol }>()(
    "Library.UpdateSelectionMissing",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export const SetupReviewFailure = Schema.Union([
  UpdateSelectionMissing,
  SetupReviewInputInvalid,
  SetupPlanStale,
  SetupManageSelectionInvalid,
  SetupDuplicateDecisionRequired,
]);
export type SetupReviewFailure = typeof SetupReviewFailure.Type;
