import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { SourceProcessLimitFailure } from "../platform/source-process-failures.js";

export class CommandFailed
  extends Schema.TaggedError<CommandFailed, { readonly brand: unique symbol }>()("CommandFailed", {
    command: Schema.String,
    exitCode: Schema.Int,
    stderr: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export const SourceLimitResource = Schema.Literals([
  "archive-files",
  "archive-bytes",
  "discovery-directories",
  "http-response-bytes",
  "discovery-download-bytes",
  "discovery-file-bytes",
  "source-download-bytes",
  "direct-skill-bytes",
]);
export type SourceLimitResource = typeof SourceLimitResource.Type;
export const SourcePolicyViolationReason = Schema.TaggedUnion({
  TransportFailure: { failure: Schema.Defect() },
  HttpStatus: { url: Schema.String, status: Schema.Int },
  ProcessFailed: { failure: SourceProcessLimitFailure },
  LimitExceeded: {
    resource: SourceLimitResource,
    limit: Schema.Int,
    actual: Schema.NumberFromString,
  },
  ArchiveEntryUnsupported: { path: Schema.String, kind: Schema.String },
  ArchiveLink: { format: Schema.Literals(["zip", "tar", "tar.gz"]) },
  LockedPathInvalid: { path: Schema.String, rule: Schema.Literals(["relative", "skill-document"]) },
  LockedPathMissing: { path: Schema.String },
  LockedPathsAbsent: { paths: Schema.Array(Schema.String) },
  GitPathOutsideCheckout: { path: Schema.String, resolved: Schema.String, checkout: Schema.String },
  GitPathMissing: { path: Schema.String },
  DiscoveryBaseInvalid: { origin: Schema.String },
  DiscoverySelectionInvalid: { names: Schema.Array(Schema.String) },
  DiscoveryIndexInvalid: { url: Schema.String, failure: SchemaFailure },
  DiscoverySchemaUnsupported: { schema: Schema.String },
  DiscoverySkillCountInvalid: { actual: Schema.Int, minimum: Schema.Int, maximum: Schema.Int },
  DiscoverySkillMissing: { name: Schema.String },
  DiscoveryNameInvalid: { name: Schema.String },
  DiscoveryNameDuplicate: { name: Schema.String },
  DiscoveryHashInvalid: { name: Schema.String, digest: Schema.String },
  DiscoveryUrlUnsafe: { name: Schema.String, url: Schema.String },
  DiscoveryHashMismatch: { name: Schema.String, expected: Schema.String, actual: Schema.String },
  DiscoveryArchiveUnsupported: { name: Schema.String },
  DiscoverySkillDocumentMissing: { name: Schema.String },
  DiscoverySkillDocumentUnlisted: { name: Schema.String, files: Schema.Array(Schema.String) },
  DiscoveryFilePathUnsafe: { path: Schema.String },
  DiscoveryFilePathDuplicate: { path: Schema.String },
  GitPinInvalid: { commit: Schema.String },
  GitTrackingRefMismatch: {
    expected: Schema.NullOr(Schema.String),
    actual: Schema.NullOr(Schema.String),
  },
  GitCommitMismatch: { expected: Schema.String, actual: Schema.String },
  GitRevisionUnavailable: {
    revision: Schema.String,
    remote: Schema.String,
    failure: CommandFailed,
  },
  GitLocatorRequired: { kind: Schema.String },
  GitCommitMissing: { locator: Schema.String },
  RegistryVersionInvalid: { requested: Schema.String, reported: Schema.optionalKey(Schema.String) },
  RegistryVersionMismatch: { requested: Schema.String, actual: Schema.String },
  RegistryArchiveRequired: {},
});
export type SourcePolicyViolationReason = typeof SourcePolicyViolationReason.Type;
export class SourcePolicyViolation
  extends Schema.TaggedError<SourcePolicyViolation, { readonly brand: unique symbol }>()(
    "SourcePolicyViolation",
    { reason: SourcePolicyViolationReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get status() {
    return this.reason._tag === "HttpStatus" ? this.reason.status : undefined;
  }
}
export const SourceFetchFailure = Schema.Union([
  CommandFailed,
  SourcePolicyViolation,
  SourceProcessLimitFailure,
]);
export type SourceFetchFailure = typeof SourceFetchFailure.Type;

export {
  SourceProcessOutputTooLarge,
  SourceProcessTimedOut,
} from "../platform/source-process-failures.js";

export { SourceFailure, RegistryNotConfigured } from "./failures.js";
