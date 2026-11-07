import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "./failure.js";

const TreeErrorReason = Schema.Union([
  Schema.TaggedStruct("GitCommandFailed", {
    command: Schema.String,
    exitCode: Schema.Number,
  }),
  Schema.TaggedStruct("GitInspectionFailed", { detail: Schema.String }),
  Schema.TaggedStruct("EmbeddedRepository", { path: Schema.String }),
  Schema.TaggedStruct("Submodule", { path: Schema.String }),
  Schema.TaggedStruct("IgnoredRoot", {}),
  Schema.TaggedStruct("FullyExcludedRoot", {}),
  Schema.TaggedStruct("EscapedPath", { path: Schema.String }),
  Schema.TaggedStruct("InvalidSymlink", { path: Schema.String }),
  Schema.TaggedStruct("UnsupportedEntry", { path: Schema.String }),
  Schema.TaggedStruct("ChangedDuringRead", { path: Schema.String }),
  Schema.TaggedStruct("CannotRetain", {
    entryType: Schema.String,
    path: Schema.String,
  }),
]);
type TreeErrorReason = typeof TreeErrorReason.Type;

const renderReason = (reason: TreeErrorReason): string => {
  switch (reason._tag) {
    case "GitCommandFailed":
      return `${reason.command} exited with ${reason.exitCode}`;
    case "GitInspectionFailed":
      return `Unable to evaluate Git ignore rules for Artifact content: ${reason.detail}`;
    case "EmbeddedRepository":
      return `Embedded Git repository is not valid Artifact content: ${reason.path}`;
    case "Submodule":
      return `Registered Git submodule is not valid Artifact content: ${reason.path}`;
    case "IgnoredRoot":
      return "The SKIT root is ignored by the enclosing Git repository";
    case "FullyExcludedRoot":
      return "Git excludes every file in the SKIT root";
    case "EscapedPath":
      return `Path escaped tree: ${reason.path}`;
    case "InvalidSymlink":
      return `Symlinks are not valid SKIT content: ${reason.path}`;
    case "UnsupportedEntry":
      return `Unsupported filesystem entry: ${reason.path}`;
    case "ChangedDuringRead":
      return `Filesystem entry changed while reading: ${reason.path}`;
    case "CannotRetain":
      return `Cannot retain ${reason.entryType}: ${reason.path}`;
  }
};

/** Content that cannot be published as a SKIT tree. */
export class TreeError
  extends Schema.TaggedError<TreeError, { readonly brand: unique symbol }>()("TreeError", {
    reason: TreeErrorReason,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Remove or replace the reported entry in the SKIT, then retry.";
  get message() {
    return renderReason(this.reason);
  }
}
