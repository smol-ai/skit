import { Schema } from "effect";
import { HarnessName } from "./contracts.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";
import { SourceProcessLimitFailure } from "../platform/source-process-failures.js";
import { SchemaFailure } from "../shared/schema-issue.js";

export const HarnessDiscoveryReason = Schema.TaggedUnion({
  OutputLimitExceeded: {
    phase: Schema.Literals(["startup", "inventory"]),
    limitBytes: Schema.Int,
    actualBytes: Schema.Int,
    endpoint: Schema.optionalKey(Schema.String),
  },
  ResponseMissing: { method: Schema.String, stderr: Schema.optionalKey(Schema.String) },
  DirectoryOmitted: { returned: Schema.Array(Schema.String) },
  RemoteError: {
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
    diagnostic: Schema.optionalKey(Schema.String),
  },
  ExitCode: {
    command: Schema.String,
    arguments: Schema.Array(Schema.String),
    exitCode: Schema.Int,
    stderr: Schema.String,
  },
  ProcessFailed: {
    command: Schema.String,
    arguments: Schema.Array(Schema.String),
    signal: Schema.NullOr(Schema.String),
    error: Schema.Struct({ code: Schema.optionalKey(Schema.String), message: Schema.String }),
  },
  ProcessEnded: {
    command: Schema.String,
    arguments: Schema.Array(Schema.String),
    signal: Schema.NullOr(Schema.String),
  },
  ServerAddressInvalid: {
    protocol: Schema.String,
    hostname: Schema.String,
    port: Schema.String,
    hasUsername: Schema.Boolean,
    hasPassword: Schema.Boolean,
  },
  HttpStatus: { endpoint: Schema.String, status: Schema.Int },
  DirectoryMismatch: { endpoint: Schema.String, expected: Schema.String, actual: Schema.String },
  TimedOut: { timeoutMs: Schema.Int },
  ReadFailed: {
    failure: Schema.Union([
      PlatformErrorSchema,
      SourceProcessLimitFailure,
      SchemaFailure,
      Schema.Defect(),
    ]),
  },
});
export type HarnessDiscoveryReason = typeof HarnessDiscoveryReason.Type;

export class HarnessDiscoveryFailed
  extends Schema.TaggedError<HarnessDiscoveryFailed, { readonly brand: unique symbol }>()(
    "HarnessDiscoveryFailed",
    { harness: HarnessName, cwd: Schema.String, reason: HarnessDiscoveryReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
