/** Public story catalog and rendering; CLI command and interaction representations stay private. */
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect } from "effect";
import {
  OutputStory,
  outputStories as outputs,
  outputStoryKey,
  storyHome,
} from "./output-stories.js";
import { journeyStories as journeys } from "./journey-stories.js";
import { recordJourney, renderRecordedJourney } from "./journey-runner.js";
import { journeyFrames } from "./journey-replay.js";
import { InteractionEvent } from "./interaction-recorder.js";
import { commandCoverage as commands, storyCoverage as coverage } from "./coverage.js";
import type { CommandCoverage, ContractCoverage } from "./contracts.js";
import { cliLayer } from "../application.js";
import { renderFailureFrame, renderResultFrame } from "../commands/output-frame.js";
import { renderBlocks } from "../terminal/blocks.js";
import { blockGallery } from "./block-gallery.js";
import { frameGallery } from "./frame-gallery.js";
import { renderReplayFrame } from "./frame.js";
import type { TerminalFrame, TerminalEnvironment } from "../terminal/contracts.js";
import type { Journey, JourneyRecording, Output } from "./contracts.js";

export type { Journey, Output, JourneyRecording, ReplayFrame } from "./contracts.js";
export {
  defaultTerminalEnvironment,
  type TerminalFrame,
  type TerminalEnvironment,
} from "../terminal/contracts.js";
export { STATUS_FRAME_MS, CLEAR_STATUS_LINE, renderStatusLine } from "../terminal/status.js";
export { renderReplayFrame } from "./frame.js";
export type { ContractCoverage, CommandCoverage } from "./contracts.js";
export const storyCoverage: () => ReadonlyArray<ContractCoverage> = coverage;

export const outputStories: readonly Output[] = outputs.map((story) => ({
  key: outputStoryKey(story),
  ...(story._tag === "Failure"
    ? {
        errorTags: story.failure.cause.reasons.flatMap((reason) => {
          const error = Cause.isFailReason(reason)
            ? reason.error
            : Cause.isDieReason(reason)
              ? reason.defect
              : undefined;
          return typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            typeof error._tag === "string"
            ? [error._tag]
            : [];
        }),
      }
    : {}),
  ...(story._tag === "Result" && story.scenario ? { scenario: story.scenario } : {}),
}));

export const journeyStories: readonly Journey[] = journeys.map((story) => ({
  name: story.name,
  description: story.description,
  ...(story.evidence ? { evidence: story.evidence } : {}),
  record: recordJourney(story).pipe(
    Effect.provide(NodeServices.layer),
    // Creating the journey's temporary home is the only filesystem work; a failure there is a defect.
    Effect.orDie,
    Effect.map((recording): JourneyRecording => ({
      name: recording.name,
      ...(recording._tag === "Scenario"
        ? {
            _tag: recording._tag,
            world: recording.world,
            worldLabels: recording.worldLabels,
            terminalDevice: recording.terminalDevice,
          }
        : {
            _tag: recording._tag,
            initialState: recording.initialState,
            finalState: recording.finalState,
          }),
      commands: recording.events.filter(InteractionEvent.$is("Command")).map(({ line }) => line),
      frames: (environment) => journeyFrames(recording, environment),
      transcript: (environment, cwd) => renderRecordedJourney(recording, environment, cwd),
    })),
  ),
}));

/** Each Block example drawn as a terminal shows it; the Blocks themselves stay private. */
export const blockExamples = (options: {
  readonly color: boolean;
  readonly width?: number;
}): ReadonlyArray<{ name: string; output: string }> =>
  blockGallery.map(({ name, blocks }) => ({ name, output: renderBlocks(blocks, options) }));

/** Every command, with the output stories that show what it reports. */
export const commandCoverage: Effect.Effect<ReadonlyArray<CommandCoverage>> = commands.pipe(
  // The tree's type names what its handlers need; reading its help documents runs none of them.
  Effect.provide(cliLayer(false)),
  Effect.scoped,
  Effect.orDie,
);

/** Each frame the CLI draws around output, drawn by the same replay that draws journeys. */
export const frameExamples = (
  environment: TerminalEnvironment,
): ReadonlyArray<{ name: string; output: string }> =>
  frameGallery.flatMap(({ name, events }) =>
    journeyFrames(
      { _tag: "Journey", name, initialState: "", finalState: "", events, home: environment.home },
      environment,
    )
      .slice(-1)
      .map((frame) => ({ name, output: renderReplayFrame(frame, 0) })),
  );

export function renderOutputFrame(
  index: number,
  base: TerminalEnvironment,
): TerminalFrame | undefined {
  const story = outputs[index];
  const environment = { ...base, home: storyHome };
  return (
    story &&
    OutputStory.$match(story, {
      Result: ({ result }) => renderResultFrame(result, environment),
      Failure: ({ failure }) => renderFailureFrame(failure, environment),
    })
  );
}
