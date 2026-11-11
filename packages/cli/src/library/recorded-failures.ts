import { invariantFailure } from "../platform/invariant-failures.js";
import { describeFailure } from "../terminal/failure.js";
import {
  StepDefect,
  StepSchemaFailure,
  LegacyStepFailure,
} from "@smolai/skit-core/library/recorded-failures";
import { Schema, Match } from "effect";
import { schemaFailureMessages } from "../platform/schema-failure.js";
import { Block } from "../terminal/blocks.js";
import { errorMessage } from "@smolai/skit-core/shared";

export const RecordedFailure = Schema.Union([StepDefect, StepSchemaFailure, LegacyStepFailure]);
export const recordedFailure = Match.type<typeof RecordedFailure.Type>().pipe(
  Match.tagsExhaustive({
    "Library.StepSchemaFailure": ({ failure }) =>
      describeFailure({
        summary: ["The recorded data does not match its required format"],
        details: [
          Block.List({
            items: schemaFailureMessages(failure).map((message) => ({ text: [message] })),
          }),
        ],
        next: ["Correct the reported data before retrying."],
      }),
    "Library.StepDefect": ({ defect }) => {
      const cause = invariantFailure(defect);
      return cause === undefined
        ? describeFailure({
            summary: [errorMessage(defect)],
            next: ["Review the stopped operation before retrying or undoing it."],
          })
        : describeFailure({
            summary: ["Library operation stopped on an internal error"],
            details: [Block.Group({ title: "Cause", children: cause.explanation })],
            next: ["Review the stopped operation before retrying or undoing it. ", ...cause.next],
          });
    },
    "Library.LegacyStepFailure": ({ diagnostic, originalRemediation }) =>
      describeFailure({
        summary: [diagnostic],
        next: [
          originalRemediation || "Review the stopped operation before retrying or undoing it.",
        ],
      }),
  }),
);
