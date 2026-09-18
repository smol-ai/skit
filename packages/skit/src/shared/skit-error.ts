export type SkitErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_ARGUMENT"
  | "VALIDATION_FAILED"
  | "TARGET_COLLISION";

export class SkitError extends Error {
  constructor(
    readonly code: SkitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkitError";
  }
}
