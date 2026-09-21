// The CLI's failure taxonomy. Exit code and remediation live on the classified error itself;
// command metadata separately publishes the semantic exit codes callers may branch on.

import { Data, Predicate } from "effect";
import type { SkitErrorCode } from "@smolai/skit-core";

export class NotFound extends Data.TaggedError("NotFound")<{ message: string }> {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` or add the source before retrying.";
}

export class Conflict extends Data.TaggedError("Conflict")<{ message: string }> {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Run `skit doctor` and inspect the affected source before retrying.";
}

export class InvalidArgument extends Data.TaggedError("InvalidArgument")<{ message: string }> {
  readonly code = "INVALID_ARGUMENT" as const;
  readonly exitCode = 64;
  readonly remediation = "Run `skit --help` to review command usage.";
}

export class ValidationFailed extends Data.TaggedError("ValidationFailed")<{ message: string }> {
  readonly code = "VALIDATION_FAILED" as const;
  readonly exitCode = 65;
  readonly remediation = "Run `skit author validate <path>` to inspect the diagnostics.";
}

export class TargetCollision extends Data.TaggedError("TargetCollision")<{ message: string }> {
  readonly code = "TARGET_COLLISION" as const;
  readonly exitCode = 12;
  readonly remediation =
    "Two Bindings route to one destination; choose a single Scope or route, then retry.";
}

/** Anything the domain did not classify. Exit 1, as an unclassified failure always was. */
export class OperationFailed extends Data.TaggedError("OperationFailed")<{ message: string }> {
  readonly code = "OPERATION_FAILED" as const;
  readonly exitCode = 1;
  readonly remediation = "Check the reported failure and retry.";
}

export type CommandError =
  | NotFound
  | Conflict
  | InvalidArgument
  | ValidationFailed
  | TargetCollision
  | OperationFailed;

const byCode = {
  NOT_FOUND: NotFound,
  CONFLICT: Conflict,
  INVALID_ARGUMENT: InvalidArgument,
  VALIDATION_FAILED: ValidationFailed,
  TARGET_COLLISION: TargetCollision,
} satisfies Record<SkitErrorCode, new (args: { message: string }) => CommandError>;

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

/** Lift any thrown value into the taxonomy, preserving the classification the domain gave it. */
export function toCommandError(error: unknown): CommandError {
  const message = errorMessage(error);
  if (isCommandError(error)) return error;
  // A `SkitError` and a named domain failure both classify themselves by code; only the name
  // is specific to the condition.
  const classified = classifiedCode(error);
  if (classified) return new byCode[classified]({ message });
  return new OperationFailed({ message });
}

function classifiedCode(error: unknown): SkitErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code in byCode ? (code as SkitErrorCode) : undefined;
}

function isCommandError(value: unknown): value is CommandError {
  return (
    typeof value === "object" &&
    value !== null &&
    "exitCode" in value &&
    "remediation" in value &&
    "_tag" in value
  );
}
