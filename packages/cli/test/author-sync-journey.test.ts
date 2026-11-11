import { authorWatchScenarioSet } from "../src/storybook/author-watch-journey.js";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { authorSyncJourneys } from "../src/storybook/author-sync-journey.js";
import { recordJourney } from "../src/storybook/journey-runner.js";
import { journeyFrames } from "../src/storybook/journey-replay.js";
import { defaultTerminalEnvironment } from "../src/terminal/contracts.js";

for (const story of authorSyncJourneys) {
  it.live(`records ${story.name} with real owner outcomes and conservation checks`, () =>
    Effect.gen(function* () {
      const recording = yield* recordJourney(story);
      expect(recording._tag).toBe("Journey");
      if (recording._tag !== "Journey") return yield* Effect.die("Expected a journey recording");
      expect(recording.finalState, recording.finalState).not.toMatch(/^failed:/);
      expect(recording.events.some((event) => event._tag === "Command")).toBe(true);
      expect(
        recording.events.some((event) => event._tag === "Result" || event._tag === "Failure"),
      ).toBe(true);
      expect(journeyFrames(recording, defaultTerminalEnvironment).at(-1)?.output).toBeTruthy();
      for (const event of recording.events) {
        if (event._tag !== "Result" || event.result.contract !== "sync") continue;
        if (event.result.data.status === "ready" || event.result.data.status === "first_sync_ready")
          expect(event.result.data.changed).toBe(false);
      }
    }).pipe(Effect.provide(skitLayer)),
  );
}

it.live("records an atomic save through the fixture owner and both native watchers", () =>
  Effect.gen(function* () {
    const story = authorWatchScenarioSet.scenarios.find(
      (scenario) => scenario.name === "author-watch/atomic-save",
    );
    if (!story) return yield* Effect.die("Missing atomic-save scenario");
    const recording = yield* recordJourney(story);
    expect(recording._tag).toBe("Scenario");
    expect(recording.events.some((event) => event._tag === "RuleProven")).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);
