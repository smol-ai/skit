import { Schema } from "effect";
import { CommandError, errorOutputContract } from "./error-output.js";
import { failureExitCode, resultExitCode } from "./exit-code.js";
import type { CommandFailure, CommandResult } from "./types.js";
import { renderContract } from "./output-presenters.js";
import { Block, renderBlocks } from "../terminal/blocks.js";

import type { TerminalFrame, TerminalEnvironment } from "../terminal/contracts.js";
export {
  defaultTerminalEnvironment,
  type TerminalFrame,
  type TerminalEnvironment,
} from "../terminal/contracts.js";

export function renderResultFrame(
  result: CommandResult,
  environment: TerminalEnvironment,
  options?: { readonly jsonLines?: boolean },
): TerminalFrame {
  const body =
    environment.format === "json"
      ? JSON.stringify(
          { schema: result.schema, data: result.encodedData },
          null,
          options?.jsonLines ? undefined : 2,
        )
      : renderContract(result, {
          ...environment,
          detail: result.detail ?? environment.detail,
        });
  return {
    stdout: `${body}\n`,
    stderr: "",
    exitCode: resultExitCode(result),
  };
}

/** The owner supplies terminal blocks; the JSON boundary encodes the original cause. */
export function renderFailureFrame(
  failure: CommandFailure,
  environment: Pick<TerminalEnvironment, "format" | "home" | "color" | "width">,
): TerminalFrame {
  const stderr =
    environment.format === "json"
      ? `${JSON.stringify(
          {
            schema: errorOutputContract.id,
            error: Schema.encodeSync(CommandError)({ code: failure.code, cause: failure.cause }),
          },
          null,
          2,
        )}\n`
      : `${renderBlocks(failure.presentation, environment)}\n`;
  return {
    stdout: "",
    stderr,
    exitCode: failureExitCode(failure.code),
  };
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
  body: readonly Block[],
  title: string,
  environment: Pick<TerminalEnvironment, "format" | "home" | "color" | "width">,
): TerminalFrame {
  return {
    stdout: "",
    stderr:
      environment.format === "json"
        ? ""
        : `\n${renderBlocks([Block.Group({ title, children: body })], environment)}\n`,
  };
}

/** The terminal owns numbering and title presentation; callers supply only the step facts. */
export function renderStepFrame(
  step: { readonly index: number; readonly total: number; readonly title: string },
  body: readonly Block[],
  environment: Pick<TerminalEnvironment, "format" | "home" | "color" | "width">,
): TerminalFrame {
  return renderNoteFrame(body, `Step ${step.index} of ${step.total}: ${step.title}`, environment);
}
