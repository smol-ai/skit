import type { CommandFailure, CommandResult } from "../commands/types.js";
import { renderContract } from "./contract-presenters.js";

export interface TerminalFrame {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
}

export interface TerminalEnvironment {
  readonly color: boolean;
  readonly detail: "summary" | "full";
  readonly format: "human" | "json";
}

export const defaultTerminalEnvironment: TerminalEnvironment = {
  color: false,
  detail: "summary",
  format: "human",
};

export function renderResultFrame(
  result: CommandResult,
  environment: TerminalEnvironment,
): TerminalFrame | undefined {
  const body =
    environment.format === "json"
      ? JSON.stringify({ schema: result.schema, data: result.encodedData }, null, 2)
      : renderContract(result.schema, result.data, environment);
  if (body === undefined) return undefined;
  return { stdout: `${body}\n`, stderr: "", exitCode: result.exitCode };
}

export function renderFailureFrame(
  failure: CommandFailure,
  format: TerminalEnvironment["format"],
): TerminalFrame {
  const stderr =
    format === "json"
      ? `${JSON.stringify(
          {
            schema: "skit.error.v1",
            error: {
              code: failure.code,
              message: failure.message,
              remediation: failure.remediation,
            },
          },
          null,
          2,
        )}\n`
      : `Error: ${failure.message}\nNext: ${failure.remediation}\n`;
  return { stdout: "", stderr, exitCode: failure.exitCode };
}

export function renderHelpFrame(
  text: string,
  format: TerminalEnvironment["format"],
): TerminalFrame {
  const stdout =
    format === "json"
      ? `${JSON.stringify({ schema: "skit.help.v1", data: { text } }, null, 2)}\n`
      : `${text}\n`;
  return { stdout, stderr: "" };
}

export function renderNoteFrame(
  body: string,
  title: string,
  format: TerminalEnvironment["format"],
): TerminalFrame {
  return {
    stdout: "",
    stderr: format === "json" ? "" : `\n${title}\n${body}\n`,
  };
}
