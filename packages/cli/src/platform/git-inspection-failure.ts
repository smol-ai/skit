import { GitInspectionIssue, errorMessage } from "@smolai/skit-core/shared";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { sourceContentFailure } from "../library/source-fetch-failures.js";
import { Schema } from "effect";

const operationName = (operation: string) =>
  ({
    init: "Private Git ignore initialization",
    inventory: "Private Git inventory",
    "check-ignore": "Private Git ignore query",
  })[operation] ?? operation;
export const gitInspectionFailure = (issue: GitInspectionIssue): string =>
  GitInspectionIssue.match(issue, {
    ProcessFailed: ({ failure }) =>
      Schema.is(SourceFetchFailure)(failure)
        ? sourceContentFailure(failure).message
        : errorMessage(failure),
    ExitCode: ({ operation, exitCode, stderr }) =>
      `${operationName(operation)} exited with ${exitCode}${stderr ? `: ${stderr}` : ""}`,
    InvalidUtf8: ({ operation }) => `${operationName(operation)} returned invalid UTF-8`,
    IncompleteOutput: ({ operation }) => `${operationName(operation)} returned incomplete results`,
    DuplicatePaths: ({ paths }) =>
      `Private Git ignore query returned duplicate paths: ${paths.join(", ")}`,
    UnexpectedPaths: ({ paths }) =>
      `Private Git ignore query returned unexpected paths: ${paths.join(", ")}`,
    EmbeddedRepositories: ({ paths }) =>
      `Embedded repository is outside plain Author inventory: ${paths.join(", ")}`,
    NativeFilenameAmbiguous: ({ path, names }) =>
      `Ambiguous native filename for ${path}: ${names.join(", ")}`,
    Unavailable: () => "Git is unavailable; cannot honor .gitignore in this Author folder",
  });
