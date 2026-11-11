import { Context, Data, Effect, Layer, Ref } from "effect";
import { RuleFailed, type CheckRule } from "./rules.js";
import type { CommandFailure, CommandResult } from "../commands/types.js";
import {
  Prompter,
  PromptCancelled,
  type Choice,
  type PrompterShape,
} from "../terminal/prompter.js";
import { Renderer, type RendererShape } from "../terminal/renderer.js";
import type { Block } from "../terminal/blocks.js";

/** Choose by value or exact visible label; generated IDs need not be known by fixtures. */
export type ScriptedAnswer =
  | string
  | readonly string[]
  | boolean
  | { readonly label: string }
  | { readonly labels: readonly string[] };

export type PromptKind =
  | "select"
  | "autocomplete"
  | "multiselect"
  | "confirm"
  | "text"
  | "password";

export type InteractionEvent = Data.TaggedEnum<{
  /** The command line a person would type to run what follows. */
  Command: { readonly line: string };
  RuleProven: { readonly rule: string };
  PromptShown: {
    readonly kind: PromptKind;
    readonly message: string;
    readonly choices: ReadonlyArray<Choice<string>>;
  };
  PromptAnswered: { readonly answer: string | readonly string[] | boolean };
  Note: {
    readonly title: string;
    readonly body: readonly Block[];
  };
  Instruction: { readonly title: string; readonly body: readonly Block[] };
  Step: {
    readonly index: number;
    readonly total: number;
    readonly title: string;
    readonly body: readonly Block[];
  };
  StatusStarted: { readonly message: string };
  StatusUpdated: { readonly message: string };
  StatusEnded: {};
  Result: { readonly result: CommandResult };
  Failure: { readonly failure: CommandFailure };
  Help: { readonly text: string };
}>;

export const InteractionEvent = Data.taggedEnum<InteractionEvent>();

/**
 * Journeys call commands as functions, so each states the command line a person would type for
 * the run that follows.
 */
export type TypeCommand = (line: string) => Effect.Effect<void>;

interface ScriptedInteraction {
  readonly layer: Layer.Layer<Prompter | Renderer>;
  readonly typed: TypeCommand;
  readonly checkRule: CheckRule;
  readonly events: Effect.Effect<ReadonlyArray<InteractionEvent>>;
  readonly remaining: Effect.Effect<number>;
  readonly prompts: Effect.Effect<
    ReadonlyArray<Extract<InteractionEvent, { _tag: "PromptShown" }>>
  >;
  readonly notes: Effect.Effect<ReadonlyArray<Extract<InteractionEvent, { _tag: "Note" }>>>;
  readonly steps: Effect.Effect<ReadonlyArray<Extract<InteractionEvent, { _tag: "Step" }>>>;
  readonly results: Effect.Effect<ReadonlyArray<CommandResult>>;
  readonly failures: Effect.Effect<ReadonlyArray<CommandFailure>>;
}

export const makeScriptedInteraction = Effect.fn("InteractionRecorder.make")(function* (
  script: ReadonlyArray<ScriptedAnswer>,
) {
  const answers = yield* Ref.make(script);
  const events = yield* Ref.make<ReadonlyArray<InteractionEvent>>([]);
  const record = (event: InteractionEvent) => Ref.update(events, (current) => [...current, event]);
  const take = (message: string, choices: ReadonlyArray<Choice<string>> = []) =>
    Ref.modify(answers, (current) => [current[0], current.slice(1)] as const).pipe(
      Effect.flatMap((answer) =>
        Effect.gen(function* () {
          if (answer === undefined)
            return yield* Effect.die(new Error(`Prompt script exhausted: ${message}`));
          if (typeof answer !== "object" || !("label" in answer || "labels" in answer))
            return answer;
          const labels = "label" in answer ? [answer.label] : answer.labels;
          const values = yield* Effect.forEach(labels, (label) => {
            // A title names a choice; the source detail some labels add in parentheses varies by
            // fixture location, so it is not part of the answer.
            const matches = choices.filter(
              (choice) => choice.label === label || choice.label.startsWith(`${label} (`),
            );
            return matches.length === 1 && !matches[0].disabled
              ? Effect.succeed(matches[0].value)
              : Effect.die(
                  new Error(
                    `Prompt "${message}" requires one available choice labelled "${label}"`,
                  ),
                );
          });
          return "label" in answer ? values[0] : values;
        }),
      ),
    );
  const shown = (kind: PromptKind, message: string, choices: ReadonlyArray<Choice<string>>) =>
    record(InteractionEvent.PromptShown({ kind, message, choices }));
  const answered = (answer: string | readonly string[] | boolean, redact: boolean = false) =>
    record(InteractionEvent.PromptAnswered({ answer: redact ? "<redacted>" : answer }));

  const choice = <Value extends string>(
    kind: "select" | "autocomplete",
    message: string,
    choices: ReadonlyArray<Choice<Value>>,
  ) =>
    Effect.gen(function* () {
      yield* shown(kind, message, choices);
      const answer = yield* take(message, choices);
      yield* answered(answer);
      if (answer === "cancel" || answer === "escape")
        return yield* new PromptCancelled({
          prompt: message,
          reason: answer === "escape" ? "back" : "interrupt",
        });
      if (typeof answer !== "string")
        return yield* Effect.die(new Error(`Prompt "${message}" requires one choice`));
      const selected = choices.find((candidate) => candidate.value === answer);
      if (!selected)
        return yield* Effect.die(
          new Error(
            `Prompt "${message}" does not offer ${answer}; offered ${choices.map((item) => item.value).join(", ")}`,
          ),
        );
      return selected.value;
    });

  const text = (kind: "text" | "password", message: string) =>
    Effect.gen(function* () {
      yield* shown(kind, message, []);
      const answer = yield* take(message);
      yield* answered(answer, kind === "password");
      if (answer === "cancel" || answer === "escape")
        return yield* new PromptCancelled({
          prompt: message,
          reason: answer === "escape" ? "back" : "interrupt",
        });
      if (typeof answer !== "string")
        return yield* Effect.die(new Error(`Prompt "${message}" requires text`));
      return answer;
    });

  const prompter: PrompterShape = {
    select: (message, choices) => choice("select", message, choices),
    autocomplete: (message, choices) => choice("autocomplete", message, choices),
    multiselect: (message, choices) =>
      Effect.gen(function* () {
        yield* shown("multiselect", message, choices);
        const answer = yield* take(message, choices);
        yield* answered(answer);
        if (answer === "cancel" || answer === "escape")
          return yield* new PromptCancelled({
            prompt: message,
            reason: answer === "escape" ? "back" : "interrupt",
          });
        if (!Array.isArray(answer))
          return yield* Effect.die(new Error(`Prompt "${message}" requires several choices`));
        if (
          answer.some(
            (value) =>
              !choices.some(
                (choice) =>
                  (!choice.disabled && choice.value === value) || choice.removeValue === value,
              ),
          )
        )
          return yield* Effect.die(new Error(`Prompt "${message}" received an unavailable choice`));
        const groups = new Set<string>();
        for (const value of answer) {
          const selected = choices.find((item) => item.value === value);
          if (!selected?.exclusiveGroup) continue;
          if (groups.has(selected.exclusiveGroup))
            return yield* Effect.die(
              new Error(`Prompt "${message}" requires one authoritative copy`),
            );
          groups.add(selected.exclusiveGroup);
        }
        return answer.map((value) => {
          const choice = choices.find(
            (item) => item.value === value || item.removeValue === value,
          )!;
          return choice.value === value ? choice.value : choice.removeValue!;
        });
      }),
    confirm: (message) =>
      Effect.gen(function* () {
        yield* shown("confirm", message, []);
        const answer = yield* take(message);
        yield* answered(answer);
        if (answer === "cancel" || answer === "escape")
          return yield* new PromptCancelled({
            prompt: message,
            reason: answer === "escape" ? "back" : "interrupt",
          });
        if (typeof answer !== "boolean")
          return yield* Effect.die(new Error(`Prompt "${message}" requires confirmation`));
        return answer;
      }),
    text: (message) => text("text", message),
    password: (message) => text("password", message),
  };

  const renderer: RendererShape = {
    result: (result) => record(InteractionEvent.Result({ result })),
    failure: (failure) => record(InteractionEvent.Failure({ failure })),
    help: (text) => record(InteractionEvent.Help({ text })),
    note: (body, title) => record(InteractionEvent.Note({ title, body })),
    instruction: (body, title) => record(InteractionEvent.Instruction({ title, body })),
    step: (step, body) => record(InteractionEvent.Step({ ...step, body })),
    updateStatus: (message) => record(InteractionEvent.StatusUpdated({ message })),
    withStatus: (status, operation) =>
      record(
        InteractionEvent.StatusStarted({
          message: typeof status === "string" ? status : status.pending,
        }),
      ).pipe(Effect.andThen(operation), Effect.ensuring(record(InteractionEvent.StatusEnded()))),
  };

  return {
    layer: Layer.succeedContext(
      Context.empty().pipe(
        Context.add(Prompter, Prompter.of(prompter)),
        Context.add(Renderer, Renderer.of(renderer)),
      ),
    ),
    checkRule: (rule, satisfied, observed) =>
      satisfied
        ? record(InteractionEvent.RuleProven({ rule }))
        : Effect.fail(new RuleFailed({ rule, observed })),
    typed: (line) => record(InteractionEvent.Command({ line })),
    events: Ref.get(events),
    remaining: Ref.get(answers).pipe(Effect.map((current) => current.length)),
    prompts: Ref.get(events).pipe(
      Effect.map((items) => items.filter(InteractionEvent.$is("PromptShown"))),
    ),
    notes: Ref.get(events).pipe(Effect.map((items) => items.filter(InteractionEvent.$is("Note")))),
    steps: Ref.get(events).pipe(Effect.map((items) => items.filter(InteractionEvent.$is("Step")))),
    results: Ref.get(events).pipe(
      Effect.map((items) =>
        items.filter(InteractionEvent.$is("Result")).map(({ result }) => result),
      ),
    ),
    failures: Ref.get(events).pipe(
      Effect.map((items) =>
        items.filter(InteractionEvent.$is("Failure")).map(({ failure }) => failure),
      ),
    ),
  } satisfies ScriptedInteraction;
});
