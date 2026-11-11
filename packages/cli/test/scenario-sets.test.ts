import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { makeJourneyHome } from "../src/platform/storybook-fixtures.js";
import { scenarioSets } from "../src/storybook/scenario-sets.js";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";

for (const scenario of scenarioSets.flatMap((set) => set.scenarios)) {
  it.live(
    scenario.name,
    () =>
      Effect.gen(function* () {
        const interaction = yield* makeScriptedInteraction(scenario.answers);
        yield* scenario
          .run(yield* makeJourneyHome, interaction.typed, interaction.checkRule)
          .pipe(Effect.provide(interaction.layer));
        expect(yield* interaction.remaining, scenario.name).toBe(0);
        expect((yield* interaction.events)[0]?._tag, scenario.name).toBe("Command");
      }).pipe(Effect.provide(skitLayer)),
    { timeout: 30_000 },
  );
}
