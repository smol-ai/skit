import { isSkitFailure, type FailureCode } from "@smolai/skit-core";
import { Cause, Predicate } from "effect";

/**
 * The exit status each failure code ends a command with. Command metadata separately publishes
 * the statuses callers may branch on, and the exit-code tests hold the two together.
 */
export const failureExitCodes = {
  NOT_FOUND: 11,
  CONFLICT: 12,
  TARGET_COLLISION: 12,
  INVALID_ARGUMENT: 64,
  VALIDATION_FAILED: 65,
  OPERATION_FAILED: 1,
} as const satisfies Record<FailureCode, number>;

export interface ClassifiedFailure {
  code: FailureCode;
  exitCode: number;
  message: string;
  remediation: string;
}

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

/** One failure classification shared by every executable front end. */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (isSkitFailure(error))
    return {
      code: error.code,
      exitCode: failureExitCodes[error.code],
      message: error.message,
      remediation: error.remediation,
    };
  // Anything not named as a failure is a defect or a platform error nothing translated. It ends
  // the command with exit 1, as an unclassified failure always has.
  return {
    code: "OPERATION_FAILED",
    exitCode: failureExitCodes.OPERATION_FAILED,
    message: errorMessage(error),
    remediation: "Check the reported failure and retry.",
  };
}

/** The presentation boundary consumes a Cause only after the operation's scopes close. */
export function commandFailure<E>(cause: Cause.Cause<E>): ClassifiedFailure {
  const errors = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
  );
  const first = errors[0];
  const failure = classifyFailure(first);
  return {
    ...failure,
    // Cause reasons do not identify finalizers; describe secondary failures without
    // mislabelling an arbitrary programming defect as cleanup.
    message:
      errors.length > 1
        ? [
            failure.message,
            ...errors.slice(1).map((error) => `Additional failure: ${errorMessage(error)}`),
          ].join("\n")
        : failure.message,
  };
}
