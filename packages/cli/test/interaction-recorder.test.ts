import { Effect } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { Prompter } from "../src/presentation/prompter.js";
import { Renderer } from "../src/presentation/renderer.js";

describe("interactive journey recorder", () => {
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
