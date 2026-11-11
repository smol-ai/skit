import { invariantFailure } from "./invariant-failures";
import {
  StepDefect,
  StepSchemaFailure,
  LegacyStepFailure,
} from "@smolai/skit-core/library/recorded-failures";
import { Schema, Match } from "effect";
import { schemaFailure } from "./schema-failure";
import { errorMessage } from "@smolai/skit-core/shared";

export const RecordedFailure = Schema.Union([StepDefect, StepSchemaFailure, LegacyStepFailure]);
export const recordedFailure = Match.type<typeof RecordedFailure.Type>().pipe(
  Match.tagsExhaustive({
    "Library.StepSchemaFailure": ({ failure }) => ({
      message: schemaFailure(failure),
      remediation: "Correct the reported data before retrying.",
    }),
    "Library.StepDefect": ({ defect }) => ({
      message: invariantFailure(defect) ?? errorMessage(defect),
      remediation: "Review the stopped operation before retrying or undoing it.",
    }),
    "Library.LegacyStepFailure": ({ diagnostic, originalRemediation }) => ({
      message: diagnostic,
      remediation:
        originalRemediation || "Review the stopped operation before retrying or undoing it.",
    }),
  }),
);
