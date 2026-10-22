import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import {
  type TerminalEnvironment,
  journeyStories,
  recordJourney,
  journeyFrames,
  renderReplayFrame,
} from "../../../cli/src/front-end";
import { catalog, renderOutputFrame } from "../model";
import { renderImage } from "./export";

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
Writes a 2× PNG and an SVG sibling with embedded fonts.`);
} else if (values.list) {
  console.log(catalog.map(({ key }) => key).join("\n"));
} else {
  const key = positionals[0];
  const columns = Number(values.columns);
  if (positionals.length !== 1 || !key)
    throw new Error("Provide one exact story key. Use --list to see available stories.");
  if (!Number.isInteger(columns) || columns < 24 || columns > 160)
    throw new Error("--columns must be an integer from 24 to 160.");
  if (values.detail !== "summary" && values.detail !== "full")
    throw new Error("--detail must be summary or full.");
  if (values.frames && values.output) throw new Error("--frames lists frames; omit --output.");
  if (!values.frames && (!values.output || !/\.png$/i.test(values.output)))
    throw new Error("Provide --output <file.png>.");
  const item = catalog.find((entry) => entry.key === key);
  if (!item) throw new Error(`Unknown story: ${key}. Use --list to see available stories.`);
  if (item.kind === "output" && (values.frame !== undefined || values.frames))
    throw new Error("Frame selection requires a journey story.");
  const environment: TerminalEnvironment = {
    color: true,
    detail: values.detail,
    format: "human",
  };
  let ansi: string;
  if (item.kind === "journey") {
    const recording = await Effect.runPromise(
      recordJourney(journeyStories[item.index]!).pipe(Effect.provide(NodeServices.layer)),
    );
    const frames = journeyFrames(recording, environment);
    if (values.frames) {
      console.log(frames.map((frame, index) => `${index}\t${frame.label}`).join("\n"));
      process.exit(0);
    }
    const index = values.frame === undefined ? frames.length - 1 : Number(values.frame);
    const frame = /^\d+$/.test(values.frame ?? "0") ? frames[index] : undefined;
    if (!frame) throw new Error(`--frame must be between 0 and ${frames.length - 1}.`);
    ansi = renderReplayFrame(frame, 0);
  } else {
    const frame = renderOutputFrame(item.index, environment)!;
    ansi = frame.stdout + frame.stderr;
  }
  // pnpm runs package scripts from the package directory; INIT_CWD is where it was invoked.
  const output = resolve(process.env.INIT_CWD ?? process.cwd(), values.output!);
  const image = await renderImage({ ansi, command: values.command, columns });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, image.png);
  await writeFile(output.replace(/\.png$/i, ".svg"), image.svg);
  console.log(`Exported ${output}`);
}
