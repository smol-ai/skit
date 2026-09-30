import type { SkitErrorCode } from "@smolai/skit-core";
import { Predicate } from "effect";
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
    remediation: Predicate.isTagged(error, "InvalidLibraryState")
      ? "Back up the state file before recovery. To reset an alpha Library, move it aside and run `skit setup`; keep installed Skill files."
      : classified.remediation,
  };
}
