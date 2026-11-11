import { SourceProcessLimitFailure } from "../platform/source-process-failures.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";
import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "./failure.js";

export const GitInspectionIssue = Schema.TaggedUnion({
  ProcessFailed: { failure: Schema.Union([SourceProcessLimitFailure, PlatformErrorSchema]) },
  ExitCode: { operation: Schema.String, exitCode: Schema.Int, stderr: Schema.String },
  InvalidUtf8: { operation: Schema.String },
  IncompleteOutput: { operation: Schema.String },
  DuplicatePaths: { paths: Schema.Array(Schema.String) },
  UnexpectedPaths: { paths: Schema.Array(Schema.String), requested: Schema.Array(Schema.String) },
  EmbeddedRepositories: { paths: Schema.Array(Schema.String) },
  Unavailable: { root: Schema.String },
  NativeFilenameAmbiguous: { path: Schema.String, names: Schema.Array(Schema.String) },
});
export type GitInspectionIssue = typeof GitInspectionIssue.Type;

const NativeEntryType = Schema.Literals([
  "File",
  "Directory",
  "SymbolicLink",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
  "Unknown",
]);

export const TreeErrorReason = Schema.Union([
  Schema.TaggedStruct("GitCommandFailed", {
    command: Schema.String,
    exitCode: Schema.Int,
  }),
  Schema.TaggedStruct("GitInspectionFailed", { issue: GitInspectionIssue }),
  Schema.TaggedStruct("EmbeddedRepository", { path: Schema.String }),
  Schema.TaggedStruct("Submodule", { path: Schema.String }),
  Schema.TaggedStruct("IgnoredRoot", {}),
  Schema.TaggedStruct("FullyExcludedRoot", {}),
  Schema.TaggedStruct("EscapedPath", { path: Schema.String }),
  Schema.TaggedStruct("InvalidSymlink", { path: Schema.String }),
  Schema.TaggedStruct("UnsupportedEntry", { path: Schema.String }),
  Schema.TaggedStruct("ChangedDuringRead", { path: Schema.String }),
  Schema.TaggedStruct("NormalizedPathCollision", {
    path: Schema.String,
    firstPath: Schema.String,
    secondPath: Schema.String,
  }),
  Schema.TaggedStruct("NativeIdentityMissing", { path: Schema.String, entryType: NativeEntryType }),
  Schema.TaggedStruct("RootNotDirectory", { path: Schema.String, entryType: NativeEntryType }),
  Schema.TaggedStruct("CannotRetain", {
    entryType: NativeEntryType,
    path: Schema.String,
  }),
]).annotate({ identifier: "TreeErrorReason" });
export type TreeErrorReason = typeof TreeErrorReason.Type;

/** Content that cannot be published as a SKIT tree. */
export class TreeError
  extends Schema.TaggedError<TreeError, { readonly brand: unique symbol }>()("TreeError", {
    reason: TreeErrorReason,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
