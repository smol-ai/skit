import { Data, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "./failure.js";

export const TreeErrorReason = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("GitCommandFailed"),
    command: Schema.String,
    exitCode: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("GitInspectionFailed"), detail: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("EmbeddedRepository"), path: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Submodule"), path: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("IgnoredRoot") }),
  Schema.Struct({ _tag: Schema.Literal("FullyExcludedRoot") }),
  Schema.Struct({ _tag: Schema.Literal("EscapedPath"), path: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("InvalidSymlink"), path: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("UnsupportedEntry"), path: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("CannotRetain"),
    entryType: Schema.String,
    path: Schema.String,
  }),
]);
export type TreeErrorReason = typeof TreeErrorReason.Type;

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
    case "CannotRetain":
      return `Cannot retain ${reason.entryType}: ${reason.path}`;
  }
};

/** Content that cannot be published as a SKIT tree. */
export class TreeError
  extends Data.TaggedError("TreeError")<{ reason: TreeErrorReason }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Remove or replace the reported entry in the SKIT, then retry.";
  get message() {
    return renderReason(this.reason);
  }
}
