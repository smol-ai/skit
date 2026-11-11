import { describeFailure } from "../terminal/failure.js";
import {
  UpdateFailure,
  GitInspectionFailureReason,
} from "@smolai/skit-core/library/update/failures";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { errorMessage } from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { sourceContentFailure } from "./source-fetch-failures.js";

export const updateFailure = Match.type<UpdateFailure>().pipe(
  Match.tagsExhaustive({
    "Library.CollectionNotUpdatable": ({ label, source }) =>
      describeFailure({
        summary: [`${label} has no upstream source`],
        next:
          source === undefined
            ? ["Add its source again to update it."]
            : ["Run ", { code: "skit add " + source }, " to update it."],
      }),
    "Library.ReviewedChangeDiffers": ({ path }) =>
      describeFailure({
        summary: [`The installed skill at ${path} differs from the change reviewed`],
        next: ["Preview the change again."],
      }),
    "SkillsSh.GitInspectionFailed": ({ operation, reason }) =>
      describeFailure({
        summary: [
          `git ${operation} failed: ${GitInspectionFailureReason.match(reason, {
            ProcessFailed: ({ failure }) =>
              Schema.is(SourceFetchFailure)(failure)
                ? sourceContentFailure(failure).message
                : errorMessage(failure),
            ExitCode: ({ exitCode, stderr }) => `exit ${exitCode}${stderr ? `: ${stderr}` : ""}`,
          })}`,
        ],
        next: ["Check that git is installed and the repository is readable, then retry."],
      }),
  }),
);
