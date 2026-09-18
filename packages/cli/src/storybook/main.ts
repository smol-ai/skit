import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Terminal } from "effect";
import { journeyStories } from "./journey-stories.js";
import { runOutputStories } from "./output-runner.js";
import { runJourneyStories } from "./journey-runner.js";
import { outputStories, outputStoryKey } from "./output-stories.js";

const argv = process.argv.slice(2);
const query = argv.find((argument) => !argument.startsWith("--"));
const listStories = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal;
  yield* terminal.display(
    `${[
      "Command outputs",
      ...outputStories.map((story) => `  ${outputStoryKey(story)}`),
      "",
      "Interactive journeys",
      ...journeyStories.map((story) => `  journey/${story.name}`),
    ].join("\n")}\n`,
  );
});
const program =
  argv.includes("--list") || argv.length === 0
    ? listStories
    : query?.startsWith("journey/")
      ? runJourneyStories(query.slice("journey/".length))
      : query === "journey"
        ? runJourneyStories()
        : runOutputStories(argv);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
