import { journeyFrames } from "../src/storybook/journey-replay.js";
import { defaultTerminalEnvironment } from "../src/terminal/contracts.js";
import { Block } from "../src/terminal/blocks.js";
import { Cause, Effect, Exit } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { Prompter } from "../src/terminal/prompter.js";
import { Renderer } from "../src/terminal/renderer.js";
import { stripVTControlCharacters } from "node:util";
import { type RecordedJourney, renderRecordedJourney } from "../src/storybook/journey-runner.js";

describe("interactive journey recorder", () => {
  it.effect("replay keeps shell-quoted home paths exact while abbreviating path spans", () =>
    Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction([]);
      const path = "/home/story/work/review tools";
      const command = `skit add '${path}'`;
      yield* interaction.typed(command);
      yield* Effect.gen(function* () {
        const renderer = yield* Renderer;
        yield* renderer.note(
          [
            Block.Fields({
              rows: [
                { label: "Path", value: [{ path }] },
                { label: "Command", value: [{ code: command }] },
              ],
            }),
          ],
          "Review",
        );
      }).pipe(Effect.provide(interaction.layer));
      const events = yield* interaction.events;
      const journey: RecordedJourney = {
        _tag: "Journey",
        name: "quoted-path",
        home: "/home/story",
        initialState: "",
        finalState: "",
        events,
      };
      const frames = journeyFrames(journey, defaultTerminalEnvironment);
      const output = frames.at(-1)!.output;
      expect(output).toContain(`$ ${command}`);
      expect(output).toContain(`Command  ${command}`);
      expect(output).toContain("Path     ~/work/review tools");
      expect(output).not.toContain("'~/");
      const transcript = renderRecordedJourney(journey, defaultTerminalEnvironment, "/work");
      expect(transcript).toContain(command);
      expect(transcript).not.toContain("'~/");
      expect(transcript).not.toContain("\u001b");
    }),
  );

  it.effect(
    "renders recorded commands and answers through Blocks and sanitises prompt snapshots",
    () =>
      Effect.gen(function* () {
        const interaction = yield* makeScriptedInteraction(["review"]);
        yield* interaction.typed("skit enable review\u0007");
        yield* Effect.gen(function* () {
          const prompter = yield* Prompter;
          yield* prompter.select("Select\u0007 a Skill", [
            { value: "review", label: "Review\u0007", hint: "installed\u0007" },
            { value: "docs", label: "Docs", disabled: true },
          ]);
        }).pipe(Effect.provide(interaction.layer));
        const events = yield* interaction.events;
        const frames = journeyFrames(
          {
            _tag: "Journey",
            name: "terminal-controls",
            home: "/home/story",
            initialState: "",
            finalState: "",
            events,
          },
          { ...defaultTerminalEnvironment, color: true },
        );
        const prompt = frames.find((frame) => frame.prompt !== undefined)?.prompt;
        expect(stripVTControlCharacters(prompt ?? "")).toContain("? Select a Skill");
        expect(stripVTControlCharacters(prompt ?? "")).toContain("Review | installed");
        expect(prompt).not.toContain("\u0007");
        const final = stripVTControlCharacters(frames.at(-1)!.output);
        expect(final).toContain("$ skit enable review\n");
        expect(final).toContain("✓ Select a Skill … Review");
        expect(frames.at(-1)!.output).not.toContain("\u0007");
        const transcript = renderRecordedJourney(
          {
            _tag: "Journey",
            name: "terminal-controls",
            home: "/home/story",
            initialState: "",
            finalState: "",
            events,
          },
          defaultTerminalEnvironment,
          "/work",
        );
        expect(transcript).not.toContain("\u0007");
        expect(transcript).not.toContain("\u001b");
        expect(events[0]).toEqual({ _tag: "Command", line: "skit enable review\u0007" });
      }),
  );

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
        yield* renderer.note([Block.Note({ text: [selected] })], "Selected");
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

it.effect("records instructions distinctly and keeps them visible in JSON replay", () =>
  Effect.gen(function* () {
    const interaction = yield* makeScriptedInteraction([]);
    yield* Effect.gen(function* () {
      const renderer = yield* Renderer;
      yield* renderer.note([Block.Note({ text: ["Ordinary progress note"] })], "Progress");
      yield* renderer.instruction(
        [Block.Note({ text: ["Open the browser and approve login."] })],
        "Approve login",
      );
    }).pipe(Effect.provide(interaction.layer));
    const events = yield* interaction.events;
    expect(events.map((event) => event._tag)).toEqual(["Note", "Instruction"]);
    const frames = journeyFrames(
      {
        _tag: "Journey",
        name: "approval",
        home: "/home/story",
        initialState: "",
        finalState: "",
        events,
      },
      { ...defaultTerminalEnvironment, format: "json" },
    );
    expect(frames.at(-1)?.output).toContain("Open the browser and approve login.");
    expect(frames.at(-1)?.output).not.toContain("Ordinary progress note");
  }),
);
