import { PlatformErrorSchema } from "../platform/error-schema.js";
import { Schema } from "effect";
import { InstallDestination } from "../installed-skills/destination.js";
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

export const DuplicateScanIssue = Schema.TaggedUnion({
  EntryLimitExceeded: { limit: Schema.Int, count: Schema.Int },
  Unreadable: { error: PlatformErrorSchema },
});
export type DuplicateScanIssue = typeof DuplicateScanIssue.Type;

export class DuplicateScanIncomplete
  extends Schema.TaggedError<DuplicateScanIncomplete, { readonly brand: unique symbol }>()(
    "DuplicateScanIncomplete",
    { path: Schema.String, reason: DuplicateScanIssue },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export const Warning = Schema.Struct({ path: Schema.String, reason: DuplicateScanIssue });
export type Warning = typeof Warning.Type;

/** The installed folder no longer has the evidence a reviewed change used. */
export class Changed
  extends Schema.TaggedError<Changed, { readonly brand: unique symbol }>()(
    "Library.InstalledSkillsChanged",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
