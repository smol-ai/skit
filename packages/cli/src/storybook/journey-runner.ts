import { Cause, Effect, Exit, Terminal } from "effect";
import { Block, renderBlocks } from "../terminal/blocks.js";
import { terminalText } from "../terminal/text.js";
import { compactHome } from "../terminal/home-path.js";
import { makeJourneyHome } from "../platform/storybook-fixtures.js";
import {
  InteractionEvent,
  makeScriptedInteraction,
  type InteractionEvent as Event,
} from "./interaction-recorder.js";
import type { StoryState } from "./contracts.js";
import { journeyStories, type JourneyStory, type ScenarioStory } from "./journey-stories.js";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderNoteFrame,
  renderStepFrame,
  renderResultFrame,
  type TerminalEnvironment,
} from "../commands/output-frame.js";

const stableHint = (hint: string | undefined, cwd: string): string =>
  hint === cwd ? "<cwd>" : (hint ?? "");

function renderEvent(
  event: Event,
  index: number,
  environment: TerminalEnvironment,
  cwd: string,
): string {
  const shown = (text: string) =>
    terminalText(environment.format === "human" ? compactHome(text, environment.home) : text);
  const body = InteractionEvent.$match(event, {
    RuleProven: ({ rule }) => `Proven: ${rule}`,
    Command: ({ line }) =>
      renderBlocks([Block.Note({ text: [{ dim: "$ " }, { code: line }] })], environment),
    PromptShown: ({ kind, message, choices }) =>
      [
        `${shown(message)} (${kind})`,
        ...choices.map((choice) => {
          const hint = stableHint(choice.hint, cwd);
          return `  ${shown(choice.value)} — ${shown(choice.label)}${hint ? ` | ${shown(hint)}` : ""}`;
        }),
      ].join("\n"),
    PromptAnswered: ({ answer }) =>
      `answered ${shown(typeof answer === "object" ? answer.join(", ") : String(answer))}`,
    Instruction: ({ title, body }) =>
      renderNoteFrame(body, title, { ...environment, format: "human" }).stderr.trim(),
    Note: ({ title, body }) => renderNoteFrame(body, title, environment).stderr.trim(),
    Step: ({ index, total, title, body }) =>
      renderStepFrame({ index, total, title }, body, environment).stderr.trim(),
    StatusStarted: ({ message }) => `${shown(message)}…`,
    StatusUpdated: ({ message }) => `${shown(message)}…`,
    StatusEnded: () => "status cleared",
    Result: ({ result }) => {
      const frame = renderResultFrame(result, environment);
      return [frame.stdout, frame.stderr].filter(Boolean).join("\n");
    },
    Failure: ({ failure }) => {
      const frame = renderFailureFrame(failure, environment);
      return [frame.stdout, frame.stderr].filter(Boolean).join("\n");
    },
    Help: ({ text }) => text,
  });
  return `${index + 1}. ${body}`;
}

export type RecordedJourney = StoryState & {
  readonly name: string;
  readonly events: ReadonlyArray<Event>;
  /** The home folder lives only while recording. */
  readonly home: string;
};

export const recordJourney = Effect.fn("Storybook.recordJourney")(
  function* <A, E, R>(story: JourneyStory<A, E, R> | ScenarioStory<E, R>) {
    const interaction = yield* makeScriptedInteraction(story.answers);
    const home = yield* makeJourneyHome;
    const run =
      story._tag === "Scenario"
        ? story.run(home, interaction.typed, interaction.checkRule).pipe(Effect.as(undefined))
        : story
            .run(home, interaction.typed, interaction.checkRule)
            .pipe(Effect.map(story.finalState));
    const outcome = yield* Effect.exit(run.pipe(Effect.provide(interaction.layer)));
    const common = { home, name: story.name, events: yield* interaction.events };
    if (story._tag === "Scenario") {
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
      return {
        ...common,
        _tag: "Scenario",
        world: story.world,
        worldLabels: story.worldLabels,
        terminalDevice: story.terminalDevice,
      } satisfies RecordedJourney;
    }
    const recording: RecordedJourney = {
      ...common,
      _tag: "Journey",
      initialState: story.initialState,
      finalState: Exit.isSuccess(outcome)
        ? String(outcome.value)
        : `${story.expectedOutcome === "failure" ? "expected failure" : "failed"}: ${Cause.pretty(outcome.cause).split("\n")[0]}`,
    };
    return recording;
  },
  // The journey's home folder lives only while it records.
  Effect.scoped,
);

export function renderRecordedJourney(
  journey: RecordedJourney,
  base: TerminalEnvironment,
  cwd: string,
): string {
  const environment = { ...base, home: journey.home };
  const transcript = [
    renderBlocks([Block.Heading({ text: `journey/${journey.name}` })], environment),
    ...(journey._tag === "Scenario"
      ? Object.entries(journey.world).map(
          ([field, value]) =>
            `${journey.worldLabels[field]}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
        )
      : [`initial: ${journey.initialState}`]),
    "",
    ...journey.events.map((event, index) => renderEvent(event, index, environment, cwd)),
    "",
    ...(journey._tag === "Journey" ? [`final: ${journey.finalState}`] : []),
  ].join("\n");
  return transcript;
}

export const renderJourney = Effect.fn("Storybook.renderJourney")(function* <A, E, R>(
  story: JourneyStory<A, E, R> | ScenarioStory<E, R>,
  environment: TerminalEnvironment,
  cwd: string,
) {
  return renderRecordedJourney(yield* recordJourney(story), environment, cwd);
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
