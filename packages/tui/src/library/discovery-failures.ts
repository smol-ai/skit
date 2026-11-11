import {
  HarnessDiscoveryFailed,
  HarnessDiscoveryReason,
} from "@smolai/skit-core/harnesses/discovery-failures";
import { Schema } from "effect";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { sourceFetchFailure } from "./source-fetch-failures";
import { schemaFailure } from "./schema-failure";
import { errorMessage, SchemaFailure } from "@smolai/skit-core/shared";

export const harnessDiscoveryFailure = ({ harness, cwd, reason }: HarnessDiscoveryFailed) => {
  const label = { codex: "Codex", "claude-code": "Claude", opencode: "OpenCode", devin: "Devin" }[
    harness
  ];
  const message = HarnessDiscoveryReason.match(reason, {
    OutputLimitExceeded: ({ phase, limitBytes, actualBytes, endpoint }) =>
      `${label} ${phase}${endpoint ? ` (${endpoint})` : ""} returned ${actualBytes} bytes, exceeding the ${limitBytes}-byte discovery limit.`,
    ResponseMissing: ({ method, stderr }) =>
      `${label} exited without a ${method} response.${stderr?.trim() ? ` ${stderr.trim()}` : ""}`,
    DirectoryOmitted: ({ returned }) =>
      `${label} omitted ${cwd} from its discovery response${returned.length ? `; it returned ${returned.join(", ")}` : ""}.`,
    RemoteError: ({ method, diagnostic }) =>
      `${label}${method === undefined ? " reported a discovery error" : ` rejected ${method}`}${diagnostic === undefined ? "." : `: ${diagnostic}`}`,
    ExitCode: ({ command, exitCode, stderr }) =>
      `${command} exited with ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
    ProcessFailed: ({ command, error }) =>
      `${command} could not complete discovery${error.code ? ` (${error.code})` : ""}: ${error.message}`,
    ProcessEnded: ({ command, signal }) =>
      `${command} ended ${signal === null ? "without an exit status" : `after signal ${signal}`} during discovery.`,
    ServerAddressInvalid: () => `${label} returned an unexpected server address.`,
    HttpStatus: ({ endpoint, status }) => `${label} ${endpoint} returned HTTP ${status}.`,
    DirectoryMismatch: ({ expected, actual }) =>
      `${label} returned inventory for ${actual}; doctor requested ${expected}.`,
    TimedOut: ({ timeoutMs }) => `${label} discovery timed out after ${timeoutMs / 1000} seconds.`,
    ReadFailed: ({ failure }) =>
      `${label} discovery failed: ${Schema.is(SourceFetchFailure)(failure) ? sourceFetchFailure(failure).message : Schema.is(SchemaFailure)(failure) ? schemaFailure(failure) : errorMessage(failure)}`,
  });
  return {
    message,
    remediation:
      "Check that the harness runs and its discovery output is valid, then retry doctor.",
  };
};
