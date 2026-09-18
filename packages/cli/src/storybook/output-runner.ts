import { Effect, Terminal } from "effect";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderResultFrame,
  type TerminalEnvironment,
  type TerminalFrame,
} from "../presentation/output-frame.js";
import { OutputStory, outputStories, outputStoryKey } from "./output-stories.js";

interface Options {
  readonly query?: string;
  readonly environment: TerminalEnvironment;
}

export const outputStoryQuery = (argv: ReadonlyArray<string>): string | undefined =>
  argv.find((argument) => !argument.startsWith("--"));

function options(argv: ReadonlyArray<string>): Options {
  const value = (flag: string) =>
    argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const format = value("--format");
  const detail = value("--detail");
  return {
    query: outputStoryQuery(argv),
    environment: {
      ...defaultTerminalEnvironment,
      color: argv.includes("--color"),
      detail: detail === "full" ? "full" : "summary",
      format: format === "json" ? "json" : "human",
    },
  };
}

function storyFrame(story: OutputStory, environment: TerminalEnvironment): TerminalFrame {
  return OutputStory.$match(story, {
    Result: ({ result }) =>
      renderResultFrame(result, environment) ?? {
        stdout: "",
        stderr: `No presenter registered for ${result.schema}\n`,
        exitCode: 1,
      },
    Failure: ({ failure }) => renderFailureFrame(failure, environment.format),
  });
}

function renderStory(story: OutputStory, environment: TerminalEnvironment): string {
  const frame = storyFrame(story, environment);
  return [
    `\u001b[1m${outputStoryKey(story)}\u001b[0m`,
    `${environment.format} · ${environment.detail}${environment.color ? " · color" : ""}`,
    ...(frame.stdout ? ["", "stdout", frame.stdout.trimEnd()] : []),
    ...(frame.stderr ? ["", "stderr", frame.stderr.trimEnd()] : []),
    ...(frame.exitCode === undefined ? [] : ["", `exit ${frame.exitCode}`]),
  ].join("\n");
}

export const runOutputStories = Effect.fn("Storybook.runOutputStories")(function* (
  argv: ReadonlyArray<string>,
) {
  const terminal = yield* Terminal.Terminal;
  const parsed = options(argv);
  const stories = parsed.query
    ? outputStories.filter((story) => outputStoryKey(story).includes(parsed.query ?? ""))
    : outputStories;
  if (!stories.length) {
    yield* terminal.display(`No stories match ${parsed.query}\n`);
    return;
  }
  yield* terminal.display(
    `${stories.map((story) => renderStory(story, parsed.environment)).join("\n\n")}\n`,
  );
});
