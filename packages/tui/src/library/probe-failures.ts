import { HarnessProbeFailure, UnknownHarness } from "@smolai/skit-core/harnesses/probe-failures";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { sourceFetchFailure } from "./source-fetch-failures";
import { errorMessage } from "@smolai/skit-core/shared";
import { Schema } from "effect";

const processFailure = (failure: unknown): string =>
  Schema.is(SourceFetchFailure)(failure)
    ? sourceFetchFailure(failure).message
    : errorMessage(failure);
export const harnessProbeFailure = (failure: HarnessProbeFailure): string =>
  HarnessProbeFailure.match(failure, {
    ExecutableMissing: ({ command }) => `Executable not found on PATH: ${command}`,
    ExitCode: ({ command, exitCode }) => `${command} --version exited with ${exitCode}`,
    ProcessFailed: ({ failure }) => processFailure(failure),
  });
export const unknownHarnessFailure = ({ value, allowed }: UnknownHarness) => ({
  message: allowed ? `--for must be ${allowed.join(", ")}` : `Unknown harness: ${value}`,
  remediation: "Choose one of the supported Harnesses.",
});
