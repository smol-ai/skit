import { HarnessMetadataInvalid } from "../metadata-failures.js";
import { Schema } from "effect";
import { HarnessName } from "../contracts.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

import { HarnessDiscoveryFailed } from "../discovery-failures.js";
import { HarnessProbeFailure } from "../probe-failures.js";
import { PlatformErrorSchema } from "../../platform/error-schema.js";
import { SchemaFailure } from "../../shared/schema-issue.js";

const NativeListingFailure = Schema.Union([PlatformErrorSchema, SchemaFailure, Schema.Defect()]);
export const ListingReadReason = Schema.TaggedUnion({
  ReadFailed: { path: Schema.String, failure: NativeListingFailure },
  DirectoryLimitExceeded: { path: Schema.String, limit: Schema.Int, actual: Schema.Int },
  InvalidFrontmatter: { path: Schema.String },
});
export type ListingReadReason = typeof ListingReadReason.Type;
export class ListingReadFailure
  extends Schema.TaggedError<ListingReadFailure, { readonly brand: unique symbol }>()(
    "ListingReadFailure",
    { reason: ListingReadReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export const ListingUnavailableReason = Schema.TaggedUnion({
  CustomRoot: { roots: Schema.Array(Schema.String) },
  DescriptionMissing: { name: Schema.String, path: Schema.String },
  DiscoveryFailed: { failure: HarnessDiscoveryFailed },
  ListingReadFailed: { failure: ListingReadFailure },
  MetadataInvalid: { failure: HarnessMetadataInvalid },
  NativeReadFailed: { failure: NativeListingFailure },
  NativeDiscoveryUnavailable: {
    status: Schema.Literals(["checked", "missing", "failed", "skipped"]),
    probeFailure: Schema.optionalKey(HarnessProbeFailure),
  },
});
export type ListingUnavailableReason = typeof ListingUnavailableReason.Type;

export const ListingEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  demand: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  collectionId: Schema.optionalKey(Schema.String),
});
export type ListingEntry = typeof ListingEntry.Type;
/** The Harnesses whose skill listing SKIT can estimate; each one's driver carries the estimator. */
export const ListingHarness = HarnessName.pick(["codex", "claude-code"]);
export type ListingHarness = typeof ListingHarness.Type;
export const ClaudeModelSource = Schema.TaggedUnion({
  Environment: { name: Schema.String },
  SettingsFile: { path: Schema.String },
  Unconfigured: {},
});
export type ClaudeModelSource = typeof ClaudeModelSource.Type;
export const ClaudeLimitSource = Schema.TaggedUnion({
  Environment: { name: Schema.Literal("SLASH_COMMAND_TOOL_CHAR_BUDGET"), value: Schema.Finite },
  ContextConversion: {
    contextWindow: Schema.Finite,
    source: Schema.Literals(["catalog", "fallback"]),
    charactersPerToken: Schema.Finite,
    fraction: Schema.Finite,
    clientVersion: Schema.String,
  },
  Unavailable: {},
});
export type ClaudeLimitSource = typeof ClaudeLimitSource.Type;
export const ListingProvenance = Schema.TaggedUnion({
  CodexAllocation: {
    contextWindow: Schema.NullOr(Schema.Finite),
    maxContextTokens: Schema.optionalKey(Schema.Finite),
    fraction: Schema.Finite,
    fallbackCharacters: Schema.Finite,
    tokenCap: Schema.Finite,
  },
  ClaudeFilesystem: {
    modelSource: ClaudeModelSource,
    limitSource: ClaudeLimitSource,
    descriptionCap: Schema.Int,
    overrideSources: Schema.Int,
    configuredFraction: Schema.optionalKey(
      Schema.Struct({ value: Schema.Finite, path: Schema.optionalKey(Schema.String) }),
    ),
  },
});
export type ListingProvenance = typeof ListingProvenance.Type;
export const NativeListingDiagnostic = Schema.Struct({
  path: Schema.String,
  diagnostic: Schema.String,
});
export type NativeListingDiagnostic = typeof NativeListingDiagnostic.Type;

const fields = {
  harness: ListingHarness,
  cwd: Schema.String,
  model: Schema.NullOr(Schema.String),
  unit: Schema.Literals(["budget-tokens", "characters"]),
  demand: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  entries: Schema.Array(ListingEntry),
  collections: Schema.Array(
    Schema.Struct({
      collectionId: Schema.String,
      skills: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      demand: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  provenance: ListingProvenance,
  skippedPaths: Schema.Array(Schema.String),
  diagnostics: Schema.Array(NativeListingDiagnostic),
};
export const ListingBudget = Schema.Union([
  Schema.TaggedStruct("Unavailable", {
    harness: fields.harness,
    cwd: Schema.String,
    reason: ListingUnavailableReason,
  }),
  Schema.TaggedStruct("DemandOnly", fields),
  Schema.TaggedStruct("Estimated", {
    ...fields,
    limit: Schema.Finite,
    fitted: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    shortened: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    descriptionsDropped: Schema.Struct({
      min: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      max: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    fidelity: Schema.Literals(["modelled", "bounded"]),
  }),
]);
export type ListingBudget = typeof ListingBudget.Type;

export function largeListingEntries(budget: ListingBudget): readonly ListingEntry[] {
  return budget._tag !== "Estimated"
    ? []
    : budget.entries
        .filter((e) => e.demand * 100 > budget.limit)
        .sort(
          (a, b) =>
            b.demand - a.demand || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
        );
}
