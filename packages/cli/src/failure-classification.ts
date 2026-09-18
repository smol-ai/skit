import type { SkitErrorCode } from "@smolai/skit-core";
import { toCommandError } from "./presentation/command-errors.js";

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
    remediation: classified.remediation,
  };
}
