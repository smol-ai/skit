import { Effect, Result } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderResultFrame,
} from "../src/presentation/output-frame.js";
import { journeyStories } from "../src/storybook/journey-stories.js";
import { renderJourney } from "../src/storybook/journey-runner.js";
import { OutputStory, outputStories, outputStoryKey } from "../src/storybook/output-stories.js";
import { outputContracts } from "../src/commands/output-contracts.js";

describe("CLI storybook catalogs", () => {
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
      const coveredContracts = new Set(
        outputStories.filter(OutputStory.$is("Result")).map((story) => story.result.schema),
      );
      expect(coveredContracts).toEqual(new Set(Object.values(outputContracts).map(({ id }) => id)));
      for (const story of outputStories) {
        for (const environment of [
          defaultTerminalEnvironment,
          { ...defaultTerminalEnvironment, format: "json" as const, detail: "full" as const },
        ]) {
          const frame = OutputStory.$match(story, {
            Result: ({ result }) => renderResultFrame(result, environment),
            Failure: ({ failure }) => renderFailureFrame(failure, environment.format),
          });
          expect(frame).toBeDefined();
        }
      }
    }),
  );

  it.effect("executes every journey through the shared Prompter and Renderer recorder", () =>
    Effect.gen(function* () {
      for (const story of journeyStories) {
        const interaction = yield* makeScriptedInteraction(story.answers);
        const result = yield* Effect.result(story.run.pipe(Effect.provide(interaction.layer)));
        expect(Result.isSuccess(result), story.name).toBe(story.expectedOutcome !== "failure");
        expect(yield* interaction.remaining, story.name).toBe(0);
        expect((yield* interaction.events).length, story.name).toBeGreaterThan(0);
      }
    }),
  );

  it.effect("renders a scripted journey defect instead of failing the viewer", () =>
    Effect.gen(function* () {
      const story = journeyStories[0];
      if (!story) return;
      const rendered = yield* renderJourney(
        { ...story, answers: [] },
        defaultTerminalEnvironment,
        "/cwd",
      );
      expect(rendered).toContain("final: failed:");
      expect(rendered).toContain("Prompt script exhausted");
    }),
  );
});
