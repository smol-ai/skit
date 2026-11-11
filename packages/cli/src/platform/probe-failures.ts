import { describeFailure } from "../terminal/failure.js";
import { HarnessProbeFailure, UnknownHarness } from "@smolai/skit-core/harnesses/probe-failures";
import { AuditProbeFailure } from "@smolai/skit-core/auditing/probe-failures";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { sourceContentFailure } from "../library/source-fetch-failures.js";
import { errorMessage } from "@smolai/skit-core/shared";
import { Schema } from "effect";

const processFailure = (failure: unknown): string =>
  Schema.is(SourceFetchFailure)(failure)
    ? sourceContentFailure(failure).message
    : errorMessage(failure);
export const harnessProbeFailure = (failure: HarnessProbeFailure): string =>
  HarnessProbeFailure.match(failure, {
    ExecutableMissing: ({ command }) => `Executable not found on PATH: ${command}`,
    ExitCode: ({ command, exitCode }) => `${command} --version exited with ${exitCode}`,
    ProcessFailed: ({ failure }) => processFailure(failure),
  });
export const unknownHarnessFailure = ({ value, allowed }: UnknownHarness) =>
  describeFailure({
    summary: [allowed ? `--for must be ${allowed.join(", ")}` : `Unknown harness: ${value}`],
    next: ["Run the command with --help to see the supported harnesses."],
  });
export const auditProbeFailure = (failure: AuditProbeFailure): string =>
  AuditProbeFailure.match(failure, {
    UndeclaredInvocation: ({ invocation }) => `Probe is not declared: ${invocation}`,
    UnsupportedHarness: ({ harness }) => `Unsupported probe: ${harness}`,
    ExitCode: ({ invocation, exitCode }) => `${invocation} exited with ${exitCode}`,
    InvalidJson: ({ invocation }) => `${invocation} did not return JSON`,
    ProcessFailed: ({ failure }) => processFailure(failure),
  });
