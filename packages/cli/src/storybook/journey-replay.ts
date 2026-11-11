import { stripVTControlCharacters } from "node:util";
import { Block, renderBlocks } from "../terminal/blocks.js";
import { renderPromptSnapshot } from "../terminal/prompt-snapshot.js";
import { InteractionEvent, type InteractionEvent as Event } from "./interaction-recorder.js";
import {
  renderFailureFrame,
  renderNoteFrame,
  renderStepFrame,
  renderResultFrame,
  type TerminalEnvironment,
} from "../commands/output-frame.js";
import type { RecordedJourney } from "./journey-runner.js";
import { compactHome } from "../terminal/home-path.js";
import { resultState, resultVariants } from "./coverage.js";

import type { ReplayFrame } from "./contracts.js";
export type { ReplayFrame } from "./contracts.js";

/** Derive screens from captured events, without rerunning a command when seeking backwards. */
export function journeyFrames(
  journey: RecordedJourney,
  base: TerminalEnvironment,
): ReadonlyArray<ReplayFrame> {
  // Frames are drawn as the person in the journey would see them: their fixture account is home.
  const environment = { ...base, home: journey.home };
  const shown = (text: string) =>
    environment.format === "human" ? compactHome(text, environment.home) : text;
  const frames: ReplayFrame[] = [{ label: "Ready", output: "" }];
  let output = "";
  let status: string | undefined;
  let prompt: Extract<Event, { _tag: "PromptShown" }> | undefined;
  const promptText = () =>
    prompt === undefined
      ? undefined
      : renderPromptSnapshot(prompt.message, prompt.choices, environment.color);
  for (const [index, event] of journey.events.entries()) {
    let label = "";
    let rule: string | undefined;
    let outcome: ReplayFrame["outcome"];
    let answer: ReplayFrame["answer"];
    InteractionEvent.$match(event, {
      RuleProven: (event) => {
        rule = event.rule;
        label = event.rule;
      },
      Command: ({ line }) => {
        if (environment.format === "human")
          output += `${output === "" ? "" : "\n"}${renderBlocks([Block.Note({ text: [{ dim: "$ " }, { code: line }] })], environment)}\n`;
        label = `$ ${line}`;
      },
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
        output += renderNoteFrame(body, title, environment).stderr;
        label = title;
      },
      Instruction: ({ body, title }) => {
        output += renderNoteFrame(body, title, { ...environment, format: "human" }).stderr;
        label = title;
      },
      Step: ({ index, total, title, body }) => {
        output += renderStepFrame({ index, total, title }, body, environment).stderr;
        label = title;
      },
      PromptShown: (event) => {
        prompt = event;
        label = event.message;
      },
      PromptAnswered: ({ answer: answered }) => {
        const values = Array.isArray(answered) ? answered : [answered];
        const labels = values.map(
          (value) =>
            prompt?.choices.find((choice) => choice.value === value)?.label ??
            (value === true ? "yes" : value === false ? "no" : String(value)),
        );
        output += `${renderBlocks([Block.Status({ tone: "ok", text: [prompt?.message ?? "Answer", " … ", labels.join(", ")] })], environment)}\n`;
        if (prompt)
          answer = {
            kind: prompt.kind,
            // Free text offers nothing to enumerate; a confirmation offers its two answers.
            offered:
              prompt.kind === "confirm"
                ? ["yes", "no"]
                : prompt.choices.filter((choice) => !choice.disabled).map((choice) => choice.label),
            chosen: labels,
          };
        prompt = undefined;
        label = `Answered ${labels.join(", ")}`;
      },
      Result: ({ result }) => {
        const frame = renderResultFrame(result, environment);
        output += frame.stdout + frame.stderr;
        status = undefined;
        const state = resultState(result);
        label = state === undefined ? result.contract : `${result.contract}: ${state}`;
        outcome = {
          contract: result.contract,
          variants: resultVariants(result),
          ...(state === undefined ? {} : { state }),
        };
      },
      Failure: ({ failure }) => {
        output += renderFailureFrame(failure, environment).stderr;
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
      ["Command", "StatusStarted", "StatusUpdated", "StatusEnded", "Note", "Step"].includes(
        event._tag,
      )
    )
      continue;
    if (!environment.color) output = stripVTControlCharacters(output);
    const promptShown = promptText();
    frames.push({
      label: shown(label),
      ...(rule === undefined ? {} : { rule }),
      // Each terminal frame already handles home paths according to its Inline roles. Applying
      // a blanket substitution here would also rewrite quoted, copyable command arguments.
      output,
      ...(status === undefined ? {} : { status: shown(status) }),
      ...(promptShown === undefined ? {} : { prompt: shown(promptShown) }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(answer === undefined
        ? {}
        : {
            answer: {
              ...answer,
              offered: answer.offered.map(shown),
              chosen: answer.chosen.map(shown),
            },
          }),
    });
  }
  return frames;
}

export { renderReplayFrame } from "./frame.js";
