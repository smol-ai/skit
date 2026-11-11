import {
  UpdateFailure,
  GitInspectionFailureReason,
} from "@smolai/skit-core/library/update/failures";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { errorMessage } from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { sourceFetchFailure } from "./source-fetch-failures";

export const updateFailure = Match.type<UpdateFailure>().pipe(
  Match.tagsExhaustive({
    "Library.CollectionNotUpdatable": ({ label, source }) => ({
      message: `${label} has no upstream source`,
      remediation:
        source === undefined
          ? "Add its source again to update it."
          : `Add ${source} again to update it.`,
    }),
    "Library.ReviewedChangeDiffers": ({ path }) => ({
      message: `The installed skill at ${path} differs from the change reviewed`,
      remediation: "Preview the change again.",
    }),
    "SkillsSh.GitInspectionFailed": ({ operation, reason }) => ({
      message: `git ${operation} failed: ${GitInspectionFailureReason.match(reason, {
        ProcessFailed: ({ failure }) =>
          Schema.is(SourceFetchFailure)(failure)
            ? sourceFetchFailure(failure).message
            : errorMessage(failure),
        ExitCode: ({ exitCode, stderr }) => `exit ${exitCode}${stderr ? `: ${stderr}` : ""}`,
      })}`,
      remediation: "Check that git is installed and the repository is readable, then retry.",
    }),
  }),
);
