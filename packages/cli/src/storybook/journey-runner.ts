import { Cause, Effect, Exit, Terminal } from "effect";
import {
  InteractionEvent,
  makeScriptedInteraction,
  type InteractionEvent as Event,
} from "../presentation/interaction-recorder.js";
import { journeyStories, type JourneyStory } from "./journey-stories.js";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderResultFrame,
  type TerminalEnvironment,
} from "../presentation/output-frame.js";

const stableHint = (hint: string | undefined, cwd: string): string =>
  hint === cwd ? "<cwd>" : (hint ?? "");

function renderEvent(
  event: Event,
  index: number,
  environment: TerminalEnvironment,
  cwd: string,
): string {
  const body = InteractionEvent.$match(event, {
    PromptShown: ({ kind, message, choices }) =>
      [
        `${message} (${kind})`,
        ...choices.map((choice) => {
          const hint = stableHint(choice.hint, cwd);
          return `  ${choice.value} — ${choice.label}${hint ? ` · ${hint}` : ""}`;
        }),
      ].join("\n"),
    PromptAnswered: ({ answer }) =>
      `answered ${Array.isArray(answer) ? answer.join(", ") : String(answer)}`,
    Note: ({ title, body }) => `${title}\n${body}`,
    StatusStarted: ({ message }) => `${message}…`,
    StatusUpdated: ({ message }) => `${message}…`,
    StatusEnded: () => "status cleared",
    Result: ({ result }) => {
      const frame = renderResultFrame(result, environment);
      if (!frame) return `result ${result.schema}`;
      return [frame.stdout, frame.stderr].filter(Boolean).join("\n");
    },
    Failure: ({ failure }) => {
      const frame = renderFailureFrame(failure, environment.format);
      return [frame.stdout, frame.stderr].filter(Boolean).join("\n");
    },
    Help: ({ text }) => text,
  });
  return `${index + 1}. ${body}`;
}

export const renderJourney = Effect.fn("Storybook.renderJourney")(function* <A, E, R>(
  story: JourneyStory<A, E, R>,
  environment: TerminalEnvironment,
  cwd: string,
) {
  const interaction = yield* makeScriptedInteraction(story.answers);
  const outcome = yield* Effect.exit(story.run.pipe(Effect.provide(interaction.layer)));
  const events = yield* interaction.events;
  const finalState = Exit.isSuccess(outcome)
    ? story.finalState(outcome.value)
    : `${story.expectedOutcome === "failure" ? "expected failure" : "failed"}: ${Cause.pretty(outcome.cause)}`;
  return [
    `\u001b[1mjourney/${story.name}\u001b[0m`,
    `initial: ${story.initialState}`,
    "",
    ...events.map((event, index) => renderEvent(event, index, environment, cwd)),
    "",
    `final: ${finalState}`,
  ].join("\n");
});

export const runJourneyStories = Effect.fn("Storybook.runJourneyStories")(function* (
  query?: string,
) {
  const terminal = yield* Terminal.Terminal;
  const environment = defaultTerminalEnvironment;
  const cwd = process.cwd();
  const stories = query
    ? journeyStories.filter((story) => story.name.includes(query))
    : journeyStories;
  if (!stories.length) {
    yield* terminal.display(`No journeys match ${query}\n`);
    return;
  }
  const rendered = yield* Effect.forEach(stories, (story) =>
    renderJourney(story, environment, cwd),
  );
  yield* terminal.display(`${rendered.join("\n\n")}\n`);
});
