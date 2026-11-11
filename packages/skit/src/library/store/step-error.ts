import { Schema, SchemaIssue } from "effect";
import { StepDefect, StepSchemaFailure } from "../recorded-failures.js";
import { StepError } from "./state-schema.js";

/** Known failures keep their native object and facts. Unexpected exceptions are defects. */
export const stepError = (error: unknown): StepError =>
  Schema.is(StepError)(error)
    ? error
    : Schema.isSchemaError(error) || SchemaIssue.isIssue(error)
      ? new StepSchemaFailure({ failure: error })
      : new StepDefect({ defect: error });
