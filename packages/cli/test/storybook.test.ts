import { Effect, Result } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderResultFrame,
} from "../src/commands/output-frame.js";
import { journeyStories } from "../src/storybook/journey-stories.js";
import { renderJourney } from "../src/storybook/journey-runner.js";
import {
  OutputStory,
  outputStories,
  outputStoryKey,
  storyHome,
} from "../src/storybook/output-stories.js";
import { commandCoverage, storyCoverage } from "../src/storybook/coverage.js";
import { cliLayer } from "../src/application.js";
import { makeJourneyHome } from "../src/platform/storybook-fixtures.js";
import { skitLayer } from "@smolai/skit-core/platform";

describe("CLI storybook catalogs", () => {
  it.effect("maps repository examples to the commands that produce them", () =>
    commandCoverage.pipe(
      Effect.map((commands) => {
        expect(
          Object.fromEntries(
            commands
              .filter(({ command }) => command.startsWith("repository "))
              .map(({ command, stories }) => [command, stories]),
          ),
        ).toEqual({
          "repository list": ["repository/list", "repository/list-empty"],
          "repository watch": ["repository/watch"],
          "repository ignore": ["repository/ignore"],
          "repository forget": ["repository/forget"],
        });
        const names = new Set(commands.map(({ command }) => command));
        for (const story of outputStories.filter(OutputStory.$is("Result"))) {
          for (const command of story.commands ?? []) {
            expect(names.has(command), `${outputStoryKey(story)} names an unknown command`).toBe(
              true,
            );
          }
        }
      }),
      Effect.provide(cliLayer(false, "/tmp/skit-storybook-repository-test")),
      Effect.scoped,
    ),
  );

  it.effect("enumerates repository actions and both list examples", () =>
    Effect.sync(() => {
      const coverage = storyCoverage().find(({ contract }) => contract === "repositoryPolicy");
      expect(coverage?.field).toBe("action");
      expect(coverage?.states).toEqual([
        { state: "list", stories: ["repository/list", "repository/list-empty"] },
        { state: "watch", stories: ["repository/watch"] },
        { state: "ignore", stories: ["repository/ignore"] },
        { state: "forget", stories: ["repository/forget"] },
      ]);
    }),
  );

  it.effect("renders repository mutations as confirmations and lists as lists", () =>
    Effect.sync(() => {
      const examples = outputStories
        .filter(OutputStory.$is("Result"))
        .filter(({ result }) => result.contract === "repositoryPolicy");
      const rendered = Object.fromEntries(
        examples.map((story) => [
          outputStoryKey(story),
          renderResultFrame(story.result, {
            ...defaultTerminalEnvironment,
            home: storyHome,
            color: false,
          }).stdout,
        ]),
      );
      expect(rendered["repository/list"]).toContain("watched");
      expect(rendered["repository/list"]).toContain("ignored");
      expect(rendered["repository/list-empty"]).toContain(
        "No repository decisions are stored for this machine.",
      );
      expect(rendered["repository/watch"]).toContain("watch ~/work/review-tools");
      expect(rendered["repository/ignore"]).toContain("ignore ~/work/scratch");
      expect(rendered["repository/forget"]).toContain("forget ~/work/review-tools");
    }),
  );

  it.effect("has unique output story keys and renders every story", () =>
    Effect.sync(() => {
      const keys = outputStories.map(outputStoryKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(
        expect.arrayContaining([
          "author-list/populated",
          "inventory/empty",
          "update/available",
          "update/applied",
          "audit/findings-v1alpha4",
        ]),
      );
      for (const story of outputStories) {
        for (const environment of [
          defaultTerminalEnvironment,
          { ...defaultTerminalEnvironment, format: "json" as const, detail: "full" as const },
        ]) {
          OutputStory.$match(story, {
            Result: ({ result }) => renderResultFrame(result, environment),
            Failure: ({ failure }) => renderFailureFrame(failure, environment),
          });
        }
      }
    }),
  );

  it.effect("has an output story for every command in the executable tree", () =>
    commandCoverage.pipe(
      Effect.map((commands) =>
        expect(
          commands.filter(({ stories }) => stories.length === 0).map(({ command }) => command),
        ).toEqual([]),
      ),
      Effect.provide(cliLayer(false, "/tmp/skit-storybook-commands-test")),
      Effect.scoped,
    ),
  );

  it.effect("has an output story for every contract and every state it reports", () =>
    Effect.sync(() => {
      const missing = storyCoverage().flatMap((coverage) => [
        ...(coverage.stories.length === 0 ? [coverage.contract] : []),
        ...coverage.states
          .filter((state) => state.stories.length === 0)
          .map((state) => `${coverage.contract}.${state.state}`),
      ]);
      expect(missing).toEqual([]);
    }),
  );

  it.live(
    "executes every journey through the shared Prompter and Renderer recorder",
    () =>
      Effect.gen(function* () {
        for (const story of journeyStories) {
          if (story._tag === "Scenario") continue;
          const interaction = yield* makeScriptedInteraction(story.answers);
          const home = yield* makeJourneyHome;
          const result = yield* Effect.result(
            story
              .run(home, interaction.typed, interaction.checkRule)
              .pipe(Effect.provide(interaction.layer)),
          );
          expect(Result.isSuccess(result), story.name).toBe(story.expectedOutcome !== "failure");
          expect(yield* interaction.remaining, story.name).toBe(0);
          // Every journey says which command it runs before anything else happens.
          expect((yield* interaction.events)[0]?._tag, story.name).toBe("Command");
        }
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    // Long-running scenario sets are tested once in their dedicated test file.
    { timeout: 180_000 },
  );

  it.effect("renders a scripted journey defect instead of failing the viewer", () =>
    Effect.gen(function* () {
      const story = journeyStories.find((story) => story.name === "doctor/cleanup-preview");
      if (!story) return;
      const rendered = yield* renderJourney(
        { ...story, answers: [] },
        defaultTerminalEnvironment,
        "/cwd",
      );
      expect(rendered).toContain("final: failed:");
      expect(rendered).toContain("Prompt script exhausted");
    }).pipe(Effect.provide(skitLayer)),
  );
});
