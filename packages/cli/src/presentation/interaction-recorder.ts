import { Context, Data, Effect, Layer, Ref } from "effect";
import type { CommandFailure, CommandResult } from "../commands/types.js";
import { Prompter, PromptCancelled, type Choice, type PrompterShape } from "./prompter.js";
import { Renderer, type RendererShape } from "./renderer.js";

/** One scripted answer: a value to choose, or a cancellation. */
export type ScriptedAnswer = string | readonly string[] | boolean | "cancel" | "escape";
export type RecordedCommandResult = Pick<
  CommandResult,
  "schema" | "data" | "encodedData" | "exitCode"
>;

export type PromptKind =
  | "select"
  | "autocomplete"
  | "multiselect"
  | "confirm"
  | "text"
  | "password";

export type InteractionEvent = Data.TaggedEnum<{
  PromptShown: {
    readonly kind: PromptKind;
    readonly message: string;
    readonly choices: ReadonlyArray<Choice<string>>;
  };
  PromptAnswered: { readonly answer: ScriptedAnswer | "<redacted>" };
  Note: { readonly title: string; readonly body: string };
  StatusStarted: { readonly message: string };
  StatusUpdated: { readonly message: string };
  StatusEnded: {};
  Result: { readonly result: RecordedCommandResult };
  Failure: { readonly failure: CommandFailure };
  Help: { readonly text: string };
}>;

export const InteractionEvent = Data.taggedEnum<InteractionEvent>();

export interface ScriptedInteraction {
  readonly layer: Layer.Layer<Prompter | Renderer>;
  readonly events: Effect.Effect<ReadonlyArray<InteractionEvent>>;
  readonly remaining: Effect.Effect<number>;
  readonly prompts: Effect.Effect<
    ReadonlyArray<Extract<InteractionEvent, { _tag: "PromptShown" }>>
  >;
  readonly notes: Effect.Effect<ReadonlyArray<Extract<InteractionEvent, { _tag: "Note" }>>>;
  readonly results: Effect.Effect<ReadonlyArray<RecordedCommandResult>>;
  readonly failures: Effect.Effect<ReadonlyArray<CommandFailure>>;
}

export const makeScriptedInteraction = Effect.fn("InteractionRecorder.make")(function* (
  script: ReadonlyArray<ScriptedAnswer>,
) {
  const answers = yield* Ref.make(script);
  const events = yield* Ref.make<ReadonlyArray<InteractionEvent>>([]);
  const record = (event: InteractionEvent) => Ref.update(events, (current) => [...current, event]);
  const take = (message: string) =>
    Ref.modify(answers, (current) => [current[0], current.slice(1)] as const).pipe(
      Effect.flatMap((answer) =>
        answer === undefined
          ? Effect.die(new Error(`Prompt script exhausted: ${message}`))
          : Effect.succeed(answer),
      ),
    );
  const shown = (kind: PromptKind, message: string, choices: ReadonlyArray<Choice<string>>) =>
    record(InteractionEvent.PromptShown({ kind, message, choices }));
  const answered = (answer: ScriptedAnswer, redact: boolean = false) =>
    record(InteractionEvent.PromptAnswered({ answer: redact ? "<redacted>" : answer }));

  const choice = <Value extends string>(
    kind: "select" | "autocomplete",
    message: string,
    choices: ReadonlyArray<Choice<Value>>,
  ) =>
    Effect.gen(function* () {
      yield* shown(kind, message, choices);
      const answer = yield* take(message);
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
        const answer = yield* take(message);
        yield* answered(answer);
        if (answer === "cancel" || answer === "escape")
          return yield* new PromptCancelled({
            prompt: message,
            reason: answer === "escape" ? "back" : "interrupt",
          });
        if (!Array.isArray(answer))
          return yield* Effect.die(new Error(`Prompt "${message}" requires several choices`));
        const selected = answer.map((value) => choices.find((choice) => choice.value === value));
        if (selected.some((item) => item === undefined))
          return yield* Effect.die(new Error(`Prompt "${message}" received an unavailable choice`));
        return selected.flatMap((item) => (item === undefined ? [] : [item.value]));
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
    result: ({ schema, data, encodedData, exitCode }) =>
      record(InteractionEvent.Result({ result: { schema, data, encodedData, exitCode } })),
    failure: (failure) => record(InteractionEvent.Failure({ failure })),
    help: (text) => record(InteractionEvent.Help({ text })),
    note: (body, title) => record(InteractionEvent.Note({ title, body })),
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
    events: Ref.get(events),
    remaining: Ref.get(answers).pipe(Effect.map((current) => current.length)),
    prompts: Ref.get(events).pipe(
      Effect.map((items) => items.filter(InteractionEvent.$is("PromptShown"))),
    ),
    notes: Ref.get(events).pipe(Effect.map((items) => items.filter(InteractionEvent.$is("Note")))),
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
