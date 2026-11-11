import { Schema } from "effect";
import { SourceProcessLimitFailure } from "../platform/source-process-failures.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";

export const AuditProbeFailure = Schema.TaggedUnion({
  UndeclaredInvocation: { invocation: Schema.String },
  UnsupportedHarness: { harness: Schema.String },
  ExitCode: { invocation: Schema.String, exitCode: Schema.Int },
  InvalidJson: { invocation: Schema.String, failure: Schema.Defect() },
  ProcessFailed: { failure: Schema.Union([SourceProcessLimitFailure, PlatformErrorSchema]) },
});
export type AuditProbeFailure = typeof AuditProbeFailure.Type;
