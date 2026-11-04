import { Data, Schema } from "effect";
import { InstallDestination } from "../vocabulary.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export const Destination = Schema.Struct({ destination: InstallDestination, root: Schema.String });
export type Destination = typeof Destination.Type;

export const Duplicate = Schema.Struct({
  name: Schema.String,
  harness: Schema.String,
  canonicalPath: Schema.String,
  aliases: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      via: Schema.Literals(["symlink", "directory", "unknown-root"]),
      linkPath: Schema.optionalKey(Schema.String),
      linkTarget: Schema.optionalKey(Schema.String),
    }),
  ),
  documentHash: Schema.String,
});
export type Duplicate = typeof Duplicate.Type;

export class DuplicateScanIncomplete
  extends Data.TaggedError("DuplicateScanIncomplete")<{
    path: string;
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Inspect the skills directory before enabling another copy.";
}

export const Warning = Schema.Struct({ path: Schema.String, message: Schema.String });
export type Warning = typeof Warning.Type;
