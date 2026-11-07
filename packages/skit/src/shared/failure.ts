// The one shape a failure takes, wherever it is raised.
//
// A failure names its condition with a tag, describes it in its message, and carries two things
// a front end needs to end a command: a code from a closed set, which a front end maps to an
// exit status, and the next step an operator can take. A failure declares itself with
// `implements SkitFailure`, so one that omits either does not compile.

import { Predicate } from "effect";

/** The closed set of codes a failure classifies itself by. */
export type FailureCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_ARGUMENT"
  | "VALIDATION_FAILED"
  | "TARGET_COLLISION"
  /** The request needs a credential the user does not have; `skit auth login` provides it. */
  | "AUTHENTICATION_REQUIRED"
  | "OPERATION_FAILED";

export const FailureTypeId = "~@smolai/skit-core/Failure";

export interface SkitFailure extends Error {
  readonly [FailureTypeId]: typeof FailureTypeId;
  readonly code: FailureCode;
  /**
   * What an operator can do next, as one or two sentences in the domain's own words. A failure
   * never names a frontend command; each frontend adds the command that does it.
   */
  readonly remediation: string;
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

export interface FailureDetails {
  readonly code: FailureCode;
  readonly message: string;
  readonly remediation: string;
}
/** Domain failure facts; each frontend owns its exit codes and presentation. */
export function failureDetails(error: unknown): FailureDetails {
  return isSkitFailure(error)
    ? { code: error.code, message: error.message, remediation: error.remediation }
    : {
        code: "OPERATION_FAILED",
        message: errorMessage(error),
        remediation: "Check the reported failure and retry.",
      };
}
