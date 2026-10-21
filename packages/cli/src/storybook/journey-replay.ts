import { stripVTControlCharacters } from "node:util";
import { createColors } from "picocolors";
import {
  InteractionEvent,
  type InteractionEvent as Event,
} from "../presentation/interaction-recorder.js";
import {
  renderFailureFrame,
  renderHelpFrame,
  renderNoteFrame,
  renderResultFrame,
  type TerminalEnvironment,
} from "../presentation/output-frame.js";
import { renderStatusLine } from "../presentation/terminal-status.js";
import type { RecordedJourney } from "./journey-runner.js";

export interface ReplayFrame {
  readonly label: string;
  readonly output: string;
  /** Captured streams are separate even when the terminal preview interleaves them. */
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: string;
  readonly prompt?: string;
}

/** Derive screens from captured events, without rerunning a command when seeking backwards. */
export function journeyFrames(
  journey: RecordedJourney,
  environment: TerminalEnvironment,
): ReadonlyArray<ReplayFrame> {
  const color = createColors(environment.color);
  const frames: ReplayFrame[] = [{ label: "Ready", output: "" }];
  let output = "";
  let stdout = "";
  let stderr = "";
  const append = (frame: { readonly stdout: string; readonly stderr: string }) => {
    stdout += frame.stdout;
    stderr += frame.stderr;
    output += frame.stdout + frame.stderr;
  };
  let status: string | undefined;
  let prompt: Extract<Event, { _tag: "PromptShown" }> | undefined;
  const promptText = () =>
    prompt === undefined
      ? undefined
      : [
          `${color.cyan("?")} ${color.bold(prompt.message)}`,
          ...prompt.choices.map(
            (choice, index) =>
              `  ${index === 0 ? color.cyan("❯") : " "} ${choice.selected && !choice.disabled ? color.green("☒") : color.dim("☐")} ${choice.disabled ? color.dim(choice.label) : index === 0 ? color.bold(choice.label) : choice.label}${choice.hint ? color.dim(` · ${choice.hint}`) : ""}`,
          ),
        ].join("\n");
  for (const [index, event] of journey.events.entries()) {
    let label = "";
    InteractionEvent.$match(event, {
      StatusStarted: ({ message }) => {
        if (environment.format === "human") status = message;
        label = message;
      },
      StatusUpdated: ({ message }) => {
        if (environment.format === "human") status = message;
        label = message;
      },
      StatusEnded: () => {
        status = undefined;
        label = "Status cleared";
      },
      Progress: ({ message }) => {
        const line = `${stripVTControlCharacters(message).replace(/[\r\n\t]/g, " ")}\n`;
        append({ stdout: "", stderr: line });
        label = `Progress: ${message}`;
      },
      Note: ({ body, title, renderBody }) => {
        append(
          renderNoteFrame(
            renderBody?.(environment.color) ?? body,
            color.bold(title),
            environment.format,
          ),
        );
        label = title;
      },
      Step: ({ index, total, title, body }) => {
        append(
          renderNoteFrame(
            body,
            `${color.dim(`Step ${index} of ${total} ·`)} ${color.bold(title)}`,
            environment.format,
          ),
        );
        label = title;
      },
      PromptShown: (event) => {
        prompt = event;
        label = event.message;
      },
      PromptAnswered: ({ answer }) => {
        const values = Array.isArray(answer) ? answer : [answer];
        const labels = values.map(
          (value) =>
            prompt?.choices.find((choice) => choice.value === value)?.label ??
            (value === true ? "yes" : value === false ? "no" : String(value)),
        );
        append({
          stdout: "",
          stderr: `${color.green("✔")} ${prompt?.message ?? "Answer"} … ${labels.join(", ")}\n`,
        });
        prompt = undefined;
        label = "Scripted answer";
      },
      Result: ({ result }) => {
        const frame = renderResultFrame(result, environment);
        append(frame);
        status = undefined;
        label = "Result";
      },
      Failure: ({ failure }) => {
        append(renderFailureFrame(failure, environment.format));
        status = undefined;
        label = "Failed";
      },
      Help: ({ text }) => {
        append(renderHelpFrame(text, environment.format));
        label = "Help";
      },
    });
    // A transient line clearing is part of the next visible change, not a separate stop.
    if (event._tag === "StatusEnded" && index < journey.events.length - 1) continue;
    if (
      environment.format === "json" &&
      ["StatusStarted", "StatusUpdated", "StatusEnded", "Note", "Step"].includes(event._tag)
    )
      continue;
    if (!environment.color) output = stripVTControlCharacters(output);
    frames.push({
      label,
      output,
      stdout,
      stderr,
      ...(status === undefined ? {} : { status }),
      ...(prompt === undefined ? {} : { prompt: promptText() }),
    });
  }
  return frames;
}

export function renderReplayFrame(frame: ReplayFrame, spinnerFrame: number): string {
  return (
    frame.output +
    (frame.prompt ? `${frame.prompt}\n` : "") +
    (frame.status ? renderStatusLine(frame.status, spinnerFrame) : "")
  );
}
