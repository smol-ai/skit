import { Cause, Effect, Exit } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { Prompter } from "../src/presentation/prompter.js";
import { Renderer } from "../src/presentation/renderer.js";

describe("interactive journey recorder", () => {
  it.effect("resolves visible labels to current choice values and records those values", () =>
    Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction([
        { label: "Review tools" },
        { labels: ["Review", "Test"] },
      ]);
      yield* Effect.gen(function* () {
        const prompter = yield* Prompter;
        expect(
          yield* prompter.select("Collection", [
            { value: "generated-collection", label: "Review tools" },
          ]),
        ).toBe("generated-collection");
        expect(
          yield* prompter.multiselect("Skills", [
            { value: "generated-review", label: "Review" },
            { value: "generated-test", label: "Test" },
          ]),
        ).toEqual(["generated-review", "generated-test"]);
      }).pipe(Effect.provide(interaction.layer));
      expect(
        (yield* interaction.events).filter((event) => event._tag === "PromptAnswered"),
      ).toEqual([
        { _tag: "PromptAnswered", answer: "generated-collection" },
        { _tag: "PromptAnswered", answer: ["generated-review", "generated-test"] },
      ]);
    }),
  );

  it.effect("refuses missing, ambiguous, and disabled labels", () =>
    Effect.gen(function* () {
      for (const choices of [
        [{ value: "other", label: "Other" }],
        [
          { value: "first", label: "Review" },
          { value: "second", label: "Review" },
        ],
        [{ value: "disabled", label: "Review", disabled: true }],
      ]) {
        const interaction = yield* makeScriptedInteraction([{ label: "Review" }]);
        const outcome = yield* Effect.exit(
          Effect.flatMap(Prompter, (prompter) => prompter.select("Skill", choices)).pipe(
            Effect.provide(interaction.layer),
          ),
        );
        expect(Exit.isFailure(outcome)).toBe(true);
        if (Exit.isFailure(outcome))
          expect(Cause.pretty(outcome.cause)).toContain(
            'requires one available choice labelled "Review"',
          );
      }
    }),
  );

  it.effect("preserves ordering across prompts, notes, and statuses", () =>
    Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction(["review", true]);
      yield* Effect.gen(function* () {
        const prompter = yield* Prompter;
        const renderer = yield* Renderer;
        const selected = yield* prompter.select("Select a Skill", [
          { value: "review", label: "Review" },
        ]);
        yield* renderer.note(selected, "Selected");
        if (yield* prompter.confirm("Apply?")) yield* renderer.withStatus("Applying", Effect.void);
      }).pipe(Effect.provide(interaction.layer));

      expect((yield* interaction.events).map((event) => event._tag)).toEqual([
        "PromptShown",
        "PromptAnswered",
        "Note",
        "PromptShown",
        "PromptAnswered",
        "StatusStarted",
        "StatusEnded",
      ]);
      expect(yield* interaction.remaining).toBe(0);
    }),
  );

  it.effect("redacts password answers in the transcript", () =>
    Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction(["secret-value"]);
      yield* Effect.gen(function* () {
        const prompter = yield* Prompter;
        expect(yield* prompter.password("Password")).toBe("secret-value");
      }).pipe(Effect.provide(interaction.layer));
      expect(yield* interaction.events).toContainEqual(
        expect.objectContaining({ _tag: "PromptAnswered", answer: "<redacted>" }),
      );
    }),
  );
});
