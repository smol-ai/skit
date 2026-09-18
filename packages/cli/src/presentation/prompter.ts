// Every question the CLI asks goes through this service.
//
// Cancellation is a typed failure rather than a sentinel each caller has to remember to check.
// Escape aborts the flow by default; a frame that means "go back one level" says so explicitly
// with catchTag, which makes the navigation contract visible instead of implied by where a break
// happens to land.

import {
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Stream,
  Terminal,
} from "effect";
import { Prompt } from "effect/unstable/cli";

export interface Choice<Value> {
  value: Value;
  label: string;
  hint?: string;
  selected?: boolean;
}

/** The person answering went back with Escape or interrupted the prompt with Ctrl+C/Ctrl+D. */
export class PromptCancelled extends Data.TaggedError("PromptCancelled")<{
  prompt: string;
  reason: "back" | "interrupt";
}> {}

// Every prompt in this CLI chooses among string values: skill refs, harness names, action verbs.
export interface PrompterShape {
  readonly select: <Value extends string>(
    message: string,
    choices: readonly Choice<Value>[],
  ) => Effect.Effect<Value, PromptCancelled>;
  readonly autocomplete: <Value extends string>(
    message: string,
    choices: readonly Choice<Value>[],
  ) => Effect.Effect<Value, PromptCancelled>;
  readonly multiselect: <Value extends string>(
    message: string,
    choices: readonly Choice<Value>[],
  ) => Effect.Effect<Value[], PromptCancelled>;
  readonly confirm: (message: string) => Effect.Effect<boolean, PromptCancelled>;
  readonly text: (message: string) => Effect.Effect<string, PromptCancelled>;
  /**
   * A secret the person types, unwrapped at this boundary.
   *
   * `Prompt.password` yields `Redacted`, which is the right default for something that should not
   * reach a log. Sign-in has to put the value in a request body, so it is unwrapped here rather
   * than threaded through the workflow half-redacted.
   */
  readonly password: (message: string) => Effect.Effect<string, PromptCancelled>;
}

export class Prompter extends Context.Service<Prompter, PrompterShape>()("skit/Prompter") {}

/** How many choices a scrolling prompt shows at once. */
export const AUTOCOMPLETE_MAX_ITEMS = 20;

const PromptAction = Data.taggedEnum<Prompt.ActionDefinition>();

const eraseRenderedLines = (lines: number): string => {
  let output = "\r\u001b[2K";
  for (let index = 1; index < lines; index++) output += "\u001b[1A\r\u001b[2K";
  return output;
};

const filterableMultiSelect = <Value extends string>(
  message: string,
  items: readonly Choice<Value>[],
): Prompt.Prompt<Value[]> => {
  const initialSelected = new Set(items.flatMap((item, index) => (item.selected ? [index] : [])));
  const initial = {
    query: "",
    cursor: 0,
    selected: initialSelected,
  };
  const visibleChoices = (state: typeof initial): number[] => {
    const query = state.query.toLocaleLowerCase();
    if (query.length === 0) return items.map((_, index) => index);
    return items.flatMap((item, index) =>
      `${item.label} ${item.hint ?? ""}`.toLocaleLowerCase().includes(query) ? [index] : [],
    );
  };
  const renderedLines = (state: typeof initial): string[] => {
    const visible = visibleChoices(state);
    const cursor = Math.min(state.cursor, Math.max(visible.length - 1, 0));
    const start = Math.max(
      0,
      Math.min(
        cursor - Math.floor(AUTOCOMPLETE_MAX_ITEMS / 2),
        visible.length - AUTOCOMPLETE_MAX_ITEMS,
      ),
    );
    const page = visible.slice(start, start + AUTOCOMPLETE_MAX_ITEMS);
    const filter = state.query.length === 0 ? "type to filter" : `filter: ${state.query}`;
    const lines = [`? ${message} › ${filter}  (Space toggle, Ctrl+A all/none)`];
    if (page.length === 0) lines.push("  No matches");
    for (const itemIndex of page) {
      const item = items[itemIndex];
      const active = visible[cursor] === itemIndex ? "❯" : " ";
      const checked = state.selected.has(itemIndex) ? "☒" : "☐";
      lines.push(`${active} ${checked} ${item.label}${item.hint ? ` - ${item.hint}` : ""}`);
    }
    return lines;
  };
  return Prompt.custom(initial, {
    render: (state, action) => {
      if (action._tag === "Beep") return Effect.succeed("\u0007");
      if (action._tag === "Submit") {
        const selected = [...state.selected].sort((left, right) => left - right);
        return Effect.succeed(
          `✔ ${message} … ${selected.map((index) => items[index].label).join(", ")}\n`,
        );
      }
      return Effect.succeed(`\u001b[?25l${renderedLines(state).join("\n")}`);
    },
    process: (input, state) => {
      const visible = visibleChoices(state);
      const cursor = Math.min(state.cursor, Math.max(visible.length - 1, 0));
      const next = (state: typeof initial) => Effect.succeed(PromptAction.NextFrame({ state }));
      if (input.key.ctrl && input.key.name === "u") return next({ ...state, query: "", cursor: 0 });
      if (input.key.ctrl && input.key.name === "a") {
        const allSelected = items.every((_, index) => state.selected.has(index));
        return next({
          ...state,
          selected: allSelected ? new Set<number>() : new Set(items.map((_, index) => index)),
        });
      }
      switch (input.key.name) {
        case "up":
          return visible.length === 0
            ? Effect.succeed(PromptAction.Beep())
            : next({
                ...state,
                cursor: cursor === 0 ? visible.length - 1 : cursor - 1,
              });
        case "down":
        case "tab":
          return visible.length === 0
            ? Effect.succeed(PromptAction.Beep())
            : next({ ...state, cursor: (cursor + 1) % visible.length });
        case "space": {
          if (visible.length === 0) return Effect.succeed(PromptAction.Beep());
          const selected = new Set(state.selected);
          const itemIndex = visible[cursor];
          if (selected.has(itemIndex)) selected.delete(itemIndex);
          else selected.add(itemIndex);
          return next({ ...state, selected });
        }
        case "backspace": {
          if (state.query.length === 0) return Effect.succeed(PromptAction.Beep());
          return next({
            ...state,
            query: state.query.slice(0, -1),
            cursor: 0,
          });
        }
        case "enter":
        case "return":
          return Effect.succeed(
            PromptAction.Submit({
              value: [...state.selected]
                .sort((left, right) => left - right)
                .map((index) => items[index].value),
            }),
          );
        default: {
          const typed = Option.getOrElse(input.input, () => "");
          return typed.length === 0
            ? Effect.succeed(PromptAction.Beep())
            : next({ ...state, query: state.query + typed, cursor: 0 });
        }
      }
    },
    clear: (state) => Effect.succeed(eraseRenderedLines(renderedLines(state).length)),
  });
};

const choices = <Value>(items: readonly Choice<Value>[]): Prompt.SelectChoice<Value>[] =>
  items.map((choice) => ({
    title: choice.label,
    value: choice.value,
    ...(choice.hint ? { description: choice.hint } : {}),
    ...(choice.selected ? { selected: true } : {}),
  }));

/**
 * Prompts render on stderr, so they never contaminate a piped stdout payload.
 *
 * Prompt draws exclusively through Terminal.display and sizes itself from Terminal.columns, so
 * pointing all three at stderr moves the whole interaction without touching any prompt call.
 */
const stderrTerminal = (
  terminal: Terminal.Terminal,
  cancellation: Ref.Ref<"back" | "interrupt">,
): Terminal.Terminal =>
  Terminal.make({
    columns: Effect.sync(() => process.stderr.columns ?? 0),
    rows: Effect.sync(() => process.stderr.rows ?? 0),
    readInput: Effect.gen(function* () {
      const source = yield* terminal.readInput;
      const target = yield* Queue.make<Terminal.UserInput, Cause.Done>();
      yield* Stream.fromQueue(source).pipe(
        Stream.runForEach((input) =>
          input.key.name === "escape"
            ? Ref.set(cancellation, "back").pipe(Effect.andThen(Queue.end(target)))
            : Queue.offer(target, input),
        ),
        Effect.ensuring(Queue.end(target)),
        Effect.forkScoped,
      );
      return Queue.asDequeue(target);
    }),
    readLine: terminal.readLine,
    display: (text) =>
      Effect.sync(() => {
        process.stderr.write(text);
      }),
  });

/**
 * Terminal prompts, backed by Effect's own CLI prompt loop.
 *
 * A Prompt is an Effect, so questions interrupt with the rest of the operation rather than
 * settling first behind a promise. Terminal.QuitError is the loop's own cancellation, named here
 * as the service's PromptCancelled so callers keep one vocabulary for "the person backed out".
 */
export const terminalPrompterLayer: Layer.Layer<Prompter, never, Prompt.Environment> = Layer.effect(
  Prompter,
  Effect.gen(function* () {
    const services = yield* Effect.context<Prompt.Environment>();
    const terminal = yield* Terminal.Terminal;
    const ask = <Value>(message: string, prompt: Prompt.Prompt<Value>) =>
      Effect.gen(function* () {
        const cancellation = yield* Ref.make<"back" | "interrupt">("interrupt");
        const promptTerminal = stderrTerminal(terminal, cancellation);
        const environment = Context.add(services, Terminal.Terminal, promptTerminal);
        return yield* prompt.pipe(
          Effect.provideContext(environment),
          Effect.catchTag("QuitError", () =>
            Effect.gen(function* () {
              const reason = yield* Ref.get(cancellation);
              if (reason === "back") yield* promptTerminal.display("\n").pipe(Effect.orDie);
              return yield* new PromptCancelled({ prompt: message, reason });
            }),
          ),
        );
      });

    return Prompter.of({
      select: (message, items) => ask(message, Prompt.select({ message, choices: choices(items) })),
      autocomplete: (message, items) =>
        ask(
          message,
          Prompt.autoComplete({
            message,
            choices: choices(items),
            maxPerPage: AUTOCOMPLETE_MAX_ITEMS,
          }),
        ),
      multiselect: (message, items) => ask(message, filterableMultiSelect(message, items)),
      confirm: (message) => ask(message, Prompt.confirm({ message })),
      text: (message) => ask(message, Prompt.text({ message })),
      password: (message) =>
        ask(message, Prompt.password({ message })).pipe(Effect.map(Redacted.value)),
    });
  }),
);
