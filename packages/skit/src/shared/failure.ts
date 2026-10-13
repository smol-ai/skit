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
  | "OPERATION_FAILED";

export const FailureTypeId = "~@smolai/skit-core/Failure";

export interface SkitFailure extends Error {
  readonly [FailureTypeId]: typeof FailureTypeId;
  readonly code: FailureCode;
  /** What an operator can do next, as one or two sentences. */
  readonly remediation: string;
}

export const isSkitFailure = (value: unknown): value is SkitFailure =>
  Predicate.hasProperty(value, FailureTypeId);
