import { createColors } from "picocolors";
import {
  InteractionEvent,
  type InteractionEvent as Event,
} from "../presentation/interaction-recorder.js";
import {
  renderFailureFrame,
  renderNoteFrame,
  renderResultFrame,
  type TerminalEnvironment,
} from "../presentation/output-frame.js";
import { renderStatusLine } from "../presentation/terminal-status.js";
import type { RecordedJourney } from "./journey-runner.js";

export interface ReplayFrame {
  readonly label: string;
  readonly output: string;
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
  let status: string | undefined;
  let prompt: Extract<Event, { _tag: "PromptShown" }> | undefined;
  const promptText = () =>
    prompt === undefined
      ? undefined
      : [
          `${color.cyan("?")} ${color.bold(prompt.message)}`,
          ...prompt.choices.map(
            (choice, index) =>
              `  ${index === 0 ? color.cyan("❯") : " "} ${choice.selected ? color.green("☒") : color.dim("☐")} ${choice.label}${choice.hint ? color.dim(` · ${choice.hint}`) : ""}`,
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
      Note: ({ body, title }) => {
        output += renderNoteFrame(body, title, environment.format).stderr;
        label = title;
      },
      Step: ({ index, total, title, body }) => {
        output += renderNoteFrame(
          body,
          `Step ${index} of ${total} · ${title}`,
          environment.format,
        ).stderr;
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
        output += `${color.green("✔")} ${prompt?.message ?? "Answer"} … ${labels.join(", ")}\n`;
        prompt = undefined;
        label = "Scripted answer";
      },
      Result: ({ result }) => {
        const frame = renderResultFrame(result, environment);
        if (frame) output += frame.stdout + frame.stderr;
        status = undefined;
        label = "Result";
      },
      Failure: ({ failure }) => {
        output += renderFailureFrame(failure, environment.format).stderr;
        status = undefined;
        label = "Failed";
      },
      Help: ({ text }) => {
        output += `${text}\n`;
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
    frames.push({
      label,
      output,
      ...(status === undefined ? {} : { status }),
      ...(prompt === undefined ? {} : { prompt: promptText() }),
    });
  }
  return frames;
}

export function renderReplayFrame(
  frame: ReplayFrame,
  spinnerFrame: number,
  color: boolean,
): string {
  return (
    frame.output +
    (frame.prompt ? `${frame.prompt}\n` : "") +
    (frame.status ? renderStatusLine(frame.status, spinnerFrame, color) : "")
  );
}
