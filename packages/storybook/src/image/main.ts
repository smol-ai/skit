import { parseArgs } from "node:util";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import {
  type TerminalEnvironment,
  OutputStory,
  outputStories,
  outputStoryKey,
  renderResultFrame,
  renderFailureFrame,
  journeyStories,
  recordJourney,
  journeyFrames,
  renderReplayFrame,
} from "../../../cli/src/front-end";
import { exportImage } from "./export";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    list: { type: "boolean" },
    frames: { type: "boolean" },
    output: { type: "string" },
    command: { type: "string" },
    frame: { type: "string" },
    columns: { type: "string", default: "88" },
    detail: { type: "string", default: "summary" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Usage: pnpm cli:image <exact-story-key> --output <file.png>
  --list                 List available stories
  --frames               List a journey's numbered frames
  --frame <index>         Select a journey frame (default: last)
  --command <text>        Optional command heading
  --columns <24..160>     Image content width (default: 88)
  --detail summary|full  Output detail (default: summary)
Writes a 2× PNG and a self-contained HTML sibling.`);
} else if (values.list) {
  console.log(
    [...outputStories.map(outputStoryKey), ...journeyStories.map((s) => `journey/${s.name}`)].join(
      "\n",
    ),
  );
} else {
  const key = positionals[0];
  const columns = Number(values.columns);
  if (positionals.length !== 1 || !key)
    throw new Error("Provide one exact story key. Use --list to see available stories.");
  if (!Number.isInteger(columns) || columns < 24 || columns > 160)
    throw new Error("--columns must be an integer from 24 to 160.");
  if (values.detail !== "summary" && values.detail !== "full")
    throw new Error("--detail must be summary or full.");
  if (!values.frames && (!values.output || !/\.png$/i.test(values.output)))
    throw new Error("Provide --output <file.png>.");
  const environment: TerminalEnvironment = {
    color: true,
    detail: values.detail,
    format: "human" as const,
  };
  let ansi: string;
  if (key.startsWith("journey/")) {
    const story = journeyStories.find((s) => `journey/${s.name}` === key);
    if (!story) throw new Error(`Unknown journey: ${key}`);
    const recording = await Effect.runPromise(
      recordJourney(story).pipe(Effect.provide(NodeServices.layer)),
    );
    const frames = journeyFrames(recording, environment);
    if (values.frames) {
      console.log(frames.map((frame, index) => `${index}\t${frame.label}`).join("\n"));
      process.exit(0);
    }
    const index = values.frame === undefined ? frames.length - 1 : Number(values.frame);
    const frame = frames[index];
    if (!Number.isInteger(index) || !frame)
      throw new Error(`--frame must be between 0 and ${frames.length - 1}.`);
    ansi = renderReplayFrame(frame, 0);
  } else {
    if (values.frame !== undefined || values.frames)
      throw new Error("Frame selection requires a journey story.");
    const story = outputStories.find((s) => outputStoryKey(s) === key);
    if (!story) throw new Error(`Unknown story: ${key}`);
    const frame = OutputStory.$match(story, {
      Result: ({ result }) => renderResultFrame(result, environment),
      Failure: ({ failure }) => renderFailureFrame(failure, "human"),
    });
    ansi = frame.stdout + frame.stderr;
  }
  if (values.output) {
    await exportImage({ output: values.output, ansi, command: values.command, columns });
    console.log(`Exported ${values.output}`);
  }
}
