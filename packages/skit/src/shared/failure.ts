// The one shape a failure takes, wherever it is raised.
//
// A failure names its condition with a tag and carries a code from a closed set, which a front
// end maps to an exit status. A failure declares itself with `implements SkitFailure`, so one
// that omits the code does not compile.
//
// Core failures carry data. Frontends own explanations and recovery guidance.

import { Predicate, Schema } from "effect";

/** The closed set of codes a failure classifies itself by. */
export const FailureCode = Schema.Literals([
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_ARGUMENT",
  "VALIDATION_FAILED",
  "TARGET_COLLISION",
  "AUTHENTICATION_REQUIRED",
  "OPERATION_FAILED",
]);
export type FailureCode = typeof FailureCode.Type;

export const FailureTypeId = "~@smolai/skit-core/Failure";

export interface SkitFailure extends Error {
  readonly [FailureTypeId]: typeof FailureTypeId;
  readonly code: FailureCode;
}

export const isSkitFailure = (value: unknown): value is SkitFailure =>
  Predicate.hasProperty(value, FailureTypeId);

/** The message of any failed or thrown value, without assuming its prototype. */
export function errorMessage(error: unknown): string {
  if (
    Predicate.hasProperty(error, "message") &&
    typeof error.message === "string" &&
    error.message.length > 0
  )
    return error.message;
  if (Predicate.hasProperty(error, "detail") && typeof error.detail === "string")
    return error.detail;
  if (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string") return error._tag;
  return String(error);
}
