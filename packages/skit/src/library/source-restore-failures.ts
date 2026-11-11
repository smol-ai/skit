import { ImportFailure } from "./import-failures.js";
import { PluginFailure } from "../sources/plugin-failures.js";
import { DedicatedInstallerRequired } from "../sources/installer-guidance.js";
import { PnpmSkillManaged } from "../installed-skills/pnpm-failures.js";
import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SourceFetchFailure } from "../sources/fetch-failures.js";
import { SourceFailure } from "../sources/failures.js";
import { DescriptorFailure } from "../artifact/failures.js";
import { TreeError } from "../shared/tree-error.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";

export const SourceRestoreReason = Schema.TaggedUnion({
  SourceImportMissing: {},
  NormalizationProfiles: { profiles: Schema.Array(Schema.String) },
  DescriptorMissing: {},
  SourceFetchFailed: {
    // Keep unknown defects intact live. Constructing a union of error classes can
    // otherwise apply a fieldless class's tag default to a plain Error. The union
    // still owns decoding and encoding saved failures.
    failure: Schema.Union([
      SourceFetchFailure,
      ImportFailure,
      PluginFailure,
      DedicatedInstallerRequired,
      PnpmSkillManaged,
      SourceFailure,
      DescriptorFailure,
      TreeError,
      PlatformErrorSchema,
      Schema.Defect(),
    ]).pipe(Schema.decodeTo(Schema.Unknown)),
  },
  HashMismatch: { actual: Schema.String },
});
export type SourceRestoreReason = typeof SourceRestoreReason.Type;
export class SourceRestoreInvalid
  extends Schema.TaggedError<SourceRestoreInvalid, { readonly brand: unique symbol }>()(
    "Library.SyncSourceRestoreInvalid",
    { hash: Schema.String, reason: SourceRestoreReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
