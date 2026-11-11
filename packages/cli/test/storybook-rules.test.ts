import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { RuleFailed } from "../src/storybook/rules.js";
import { journeyFrames } from "../src/storybook/journey-replay.js";
import { defaultTerminalEnvironment } from "../src/terminal/contracts.js";

it.effect("failed rules fail the run and never become proof; successful rules survive replay", () =>
  Effect.gen(function* () {
    const recorder = yield* makeScriptedInteraction([]);
    expect(
      yield* Effect.flip(recorder.checkRule("a failed rule", false, { events: ["observed"] })),
    ).toEqual(new RuleFailed({ rule: "a failed rule", observed: { events: ["observed"] } }));
    expect(yield* recorder.events).toEqual([]);
    yield* recorder.typed("skit author watch");
    yield* recorder.checkRule("a proven rule", true, { actual: 1 });
    const frames = journeyFrames(
      {
        _tag: "Journey",
        name: "rules",
        initialState: "",
        finalState: "",
        home: "/tmp/fixture",
        events: yield* recorder.events,
      },
      defaultTerminalEnvironment,
    );
    expect(frames.at(-1)?.rule).toBe("a proven rule");
  }),
);
