import type { CommandResult } from "./types.js";

/** Process statuses belong to the CLI output boundary; domain codes remain in JSON. */
export const processExitCodes = { success: 0, failure: 1, invalidUsage: 2 } as const;
export type ProcessExitCode = (typeof processExitCodes)[keyof typeof processExitCodes];

export const failureExitCode = (code: string): ProcessExitCode =>
  code === "INVALID_ARGUMENT" ? processExitCodes.invalidUsage : processExitCodes.failure;

/** Results can report refusal or partial work without failing the Effect. Inspect their facts. */
export function resultExitCode(result: CommandResult, previous = 0): ProcessExitCode {
  // A successful later scope must not hide a partially failed command. Doctor reports a
  // fresh health verdict after interactive repair, so its final check replaces the first.
  if (previous !== 0 && result.contract !== "doctor")
    return previous === processExitCodes.invalidUsage
      ? processExitCodes.invalidUsage
      : processExitCodes.failure;
  let failed: boolean;
  switch (result.contract) {
    case "validate":
      failed = result.data.status === "invalid" || result.data.status === "policy-blocked";
      break;
    case "sync":
      failed = result.data.status === "blocked" || result.data.status === "waiting_for_removal";
      break;
    case "librarySync":
      failed =
        result.data.status === "conflicted" ||
        result.data.status === "resolution_invalid" ||
        result.data.status === "enablement_incomplete";
      break;
    case "doctor":
      failed = !result.data.ok;
      break;
    case "enable":
    case "disable":
      failed = result.data.application.status === "incomplete";
      break;
    case "update":
      failed = result.data.some(
        (item) =>
          "status" in item ||
          ("installation_error" in item && item.installation_error !== undefined) ||
          ("sync_error" in item && item.sync_error !== undefined) ||
          ("sync_status" in item &&
            (item.sync_status === "blocked" || item.sync_status === "waiting_for_removal")),
      );
      break;
    case "setupFailed":
      return failureExitCode(result.data.code);
    case "setupUndo":
      failed =
        result.data.phase === "failed" ||
        result.data.phase === "stale" ||
        result.data.status === "conflicted";
      break;
    case "recovery":
      failed = ["partial", "conflicted", "stale", "failed"].includes(result.data.phase);
      break;
    default:
      failed = false;
  }
  return failed ? processExitCodes.failure : processExitCodes.success;
}
