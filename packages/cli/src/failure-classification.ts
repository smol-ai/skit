import type { SkitErrorCode } from "@smolai/skit-core";
import { Cause, Predicate } from "effect";
import { errorMessage, toCommandError } from "./presentation/command-errors.js";

export interface ClassifiedFailure {
  code: SkitErrorCode | "OPERATION_FAILED";
  exitCode: number;
  message: string;
  remediation: string;
}

/** One failure classification shared by every executable front end. */
export function classifyFailure(error: unknown): ClassifiedFailure {
  const classified = toCommandError(error);
  return {
    code: classified.code,
    exitCode: classified.exitCode,
    message: classified.message,
    // A domain failure may name its own next step; the code supplies a generic one otherwise.
    remediation:
      Predicate.hasProperty(error, "remediation") && typeof error.remediation === "string"
        ? error.remediation
        : classified.remediation,
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
