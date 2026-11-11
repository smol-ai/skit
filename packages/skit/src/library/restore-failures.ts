import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { Hash } from "../shared/hash.js";
import { CollectionVersionId, InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import { Enabled } from "./library-contracts.js";

export const RestoreOwnershipConflict = Schema.TaggedUnion({
  InstalledVersionMissing: {
    installedSkillId: InstalledSkillId,
    skillId: SkillId,
    versionId: SkillVersionId,
    path: Schema.String,
  },
  RepositorySelectionMissing: { root: Schema.String, selection: Enabled },
});
export type RestoreOwnershipConflict = typeof RestoreOwnershipConflict.Type;

export const RestoreInvalidReason = Schema.TaggedUnion({
  CopiesUnavailable: { ids: Schema.Array(CollectionVersionId) },
  SyncContentChanged: { hash: Hash },
  ForeignCopy: { hash: Schema.String },
  DownloadForSourceCopy: { hash: Hash },
  UnknownCopy: { id: Schema.String },
  SourceRestoreUnavailable: { hash: Hash },
  CopyNotAvailable: { hash: Hash },
  DownloadTransportMissing: { hashes: Schema.Array(Hash) },
  ReusableCopyMissing: { hash: Hash, path: Schema.String },
  DownloadHashMismatch: { expected: Hash, actual: Schema.String },
  MemberHashMismatch: { path: Schema.String, expected: Hash, actual: Hash },
  StateInvalid: {
    stage: Schema.Literals(["target-manifest", "restored-library", "merged-library"]),
    failure: SchemaFailure,
  },
  OwnershipWouldBeStranded: { conflicts: Schema.Array(RestoreOwnershipConflict) },
});
export type RestoreInvalidReason = typeof RestoreInvalidReason.Type;
export class RestoreInvalid
  extends Schema.TaggedError<RestoreInvalid, { readonly brand: unique symbol }>()(
    "Library.RestoreInvalid",
    { reason: RestoreInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
