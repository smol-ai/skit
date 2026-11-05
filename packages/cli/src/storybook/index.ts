/** Public story catalog and rendering; CLI command and interaction representations stay private. */
import { Effect } from "effect";
import { OutputStory, outputStories as outputs, outputStoryKey } from "./output-stories.js";
import { journeyStories as journeys } from "./journey-stories.js";
import { recordJourney, renderRecordedJourney } from "./journey-runner.js";
import { journeyFrames } from "./journey-replay.js";
import { renderFailureFrame, renderResultFrame } from "../commands/output-frame.js";
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

export const outputStories: readonly Output[] = outputs.map((story) => ({
  key: outputStoryKey(story),
}));

export const journeyStories: readonly Journey[] = journeys.map((story) => ({
  name: story.name,
  record: recordJourney(story).pipe(
    Effect.map((recording): JourneyRecording => ({
      name: recording.name,
      initialState: recording.initialState,
      finalState: recording.finalState,
      frames: (environment) => journeyFrames(recording, environment),
      transcript: (environment, cwd) => renderRecordedJourney(recording, environment, cwd),
    })),
  ),
}));

export function renderOutputFrame(
  index: number,
  environment: TerminalEnvironment,
): TerminalFrame | undefined {
  const story = outputs[index];
  return (
    story &&
    OutputStory.$match(story, {
      Result: ({ result }) => renderResultFrame(result, environment),
      Failure: ({ failure }) => renderFailureFrame(failure, environment.format),
    })
  );
}
