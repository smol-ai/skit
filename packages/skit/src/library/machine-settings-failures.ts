import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";

export const MachineSettingsInvalidReason = Schema.TaggedUnion({
  ReadFailed: { failure: PlatformErrorSchema },
  InvalidData: { failure: SchemaFailure },
  UnsupportedVersion: { version: Schema.Int, supported: Schema.Array(Schema.Int) },
});
export type MachineSettingsInvalidReason = typeof MachineSettingsInvalidReason.Type;

export class Unusable
  extends Schema.TaggedError<Unusable, { readonly brand: unique symbol }>()(
    "MachineSettingsUnusable",
    {
      path: Schema.String,
      reason: MachineSettingsInvalidReason,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class SetupNotRecorded
  extends Schema.TaggedError<SetupNotRecorded, { readonly brand: unique symbol }>()(
    "MachineSettings.SetupNotRecorded",
    {
      path: Schema.String,
      operationId: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
}

export const MachineSettingsFailure = Schema.Union([Unusable, SetupNotRecorded]);
export type MachineSettingsFailure = typeof MachineSettingsFailure.Type;
