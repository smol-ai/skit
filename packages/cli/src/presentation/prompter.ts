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
import { terminalColors } from "./terminal-style.js";
import { fitTerminalLine, renderSkillPreview } from "./skill-preview.js";

export interface Choice<Value> {
  value: Value;
  label: string;
  hint?: string;
  /** Extra context shown only for the highlighted choice. */
  detail?: string;
  /** Context displayed below every row, even while another row is highlighted. */
  description?: string;
  group?: string;
  /** Visible and previewable, but cannot be selected for addition. */
  disabled?: boolean;
  /** Selecting this row deselects the other copies in the same group. */
  exclusiveGroup?: string;
  /** Bulk selection must not resolve a conflict on the user's behalf. */
  selectExplicitly?: boolean;
  selected?: boolean;
  /** Opt in to an explicit removal action, toggled with Ctrl+R. */
  removeValue?: Value;
  /** Read only when content preview is opened for this choice. */
  preview?: () => Effect.Effect<string>;
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
  const initialSelected = new Set(
    items.flatMap((item, index) => (item.selected && !item.disabled ? [index] : [])),
  );
  const initial = {
    query: "",
    cursor: 0,
    selected: initialSelected,
    removed: new Set<number>(),
    preview: false,
    previewOffset: 0,
  };
  const visibleChoices = (state: typeof initial): number[] => {
    const query = state.query.toLocaleLowerCase();
    if (query.length === 0) return items.map((_, index) => index);
    return items.flatMap((item, index) =>
      `${item.group ?? ""} ${item.label} ${item.hint ?? ""} ${item.detail ?? ""} ${item.description ?? ""}`
        .toLocaleLowerCase()
        .includes(query)
        ? [index]
        : [],
    );
  };
  const renderedLines = (state: typeof initial, maxItems = AUTOCOMPLETE_MAX_ITEMS): string[] => {
    const visible = visibleChoices(state);
    const cursor = Math.min(state.cursor, Math.max(visible.length - 1, 0));
    const start = Math.max(
      0,
      Math.min(cursor - Math.floor(maxItems / 2), visible.length - maxItems),
    );
    const page = visible.slice(start, start + maxItems);
    const pageLineCount = () =>
      page.length +
      page.filter((index) => items[index].description).length +
      (items[visible[cursor]]?.detail ? 1 : 0) +
      page.filter((itemIndex, index) => {
        const group = items[itemIndex].group;
        return group !== undefined && (index === 0 || group !== items[page[index - 1]].group);
      }).length;
    while (pageLineCount() > maxItems && page.length > 1) {
      if (page.at(-1) === visible[cursor]) page.shift();
      else page.pop();
    }
    const filter = state.query.length === 0 ? "type to filter" : `filter: ${state.query}`;
    const color = terminalColors();
    const lines = [
      `${color.cyan("?")} ${color.bold(message)} ${color.dim(`› ${filter}  (Space toggle, Ctrl+A all/none${items.some((item) => item.removeValue !== undefined) ? ", Ctrl+R remove/undo" : ""}${items.some((item) => item.preview !== undefined) ? ", Ctrl+P preview" : ""})`)}`,
    ];
    if (items.some((item) => item.preview !== undefined)) {
      lines[0] = `${color.cyan("?")} ${color.bold(message)} ${color.dim(`› ${filter}`)}`;
      lines.push(
        color.dim(
          `Ctrl+P preview${items.some((item) => item.removeValue !== undefined) ? " · Ctrl+R remove/undo" : ""} · Space toggle · Ctrl+A all/none`,
        ),
      );
    }
    if (page.length === 0) lines.push("  No matches");
    let previousGroup: string | undefined;
    for (const itemIndex of page) {
      const item = items[itemIndex];
      if (item.group !== undefined && item.group !== previousGroup)
        lines.push(`  ${color.cyan(color.bold(`─ ${item.group}`))}`);
      previousGroup = item.group;
      const highlighted = visible[cursor] === itemIndex;
      const active = highlighted ? color.cyan("❯") : " ";
      const removed = state.removed.has(itemIndex);
      const checked = removed
        ? color.red("✕")
        : state.selected.has(itemIndex)
          ? color.green("☒")
          : color.dim("☐");
      const label = item.disabled
        ? color.dim(item.label)
        : highlighted
          ? color.bold(item.label)
          : item.label;
      const indent = item.group === undefined ? "" : "    ";
      lines.push(
        `${indent}${active} ${checked} ${label}${removed ? color.red("  · Remove") : ""}${item.hint ? color.dim(`  · ${item.hint}`) : ""}`,
      );
      if (item.description) lines.push(`${indent}    ${color.dim(item.description)}`);
      if (highlighted && item.detail) lines.push(`${indent}    ${color.dim(item.detail)}`);
    }
    return lines;
  };
  const previews = new Map<number, string>();
  let renderedCount = 1;
  let previewPageSize = 10;
  let previewOffset = 0;
  return Prompt.custom(initial, {
    render: (state, action) => {
      if (action._tag === "Beep") return Effect.succeed("\u0007");
      if (action._tag === "Submit") {
        const selected = [...state.selected].sort((left, right) => left - right);
        return Effect.succeed(
          `${terminalColors().green("✔")} ${message} … ${[...selected.map((index) => items[index].label), ...[...state.removed].map((index) => `Remove: ${items[index].label}`)].join(", ")}\n`,
        );
      }
      return Effect.gen(function* () {
        const terminal = yield* Terminal.Terminal;
        const columns = yield* terminal.columns;
        const rows = yield* terminal.rows;
        let lines: string[];
        if (state.preview) {
          const visible = visibleChoices(state);
          const index = visible[Math.min(state.cursor, Math.max(0, visible.length - 1))];
          const item = items[index];
          let content = "No content preview available.";
          if (item?.preview) {
            if (!previews.has(index)) previews.set(index, yield* item.preview());
            content = previews.get(index)!;
          }
          const height = Math.max(6, Math.min(22, (rows || 24) - 2));
          const pickerHeight =
            columns >= 110 ? height : Math.max(2, Math.floor((height - 1) * 0.4));
          const frame = renderSkillPreview({
            picker: renderedLines(state, Math.max(1, pickerHeight - 2)),
            title: item?.label ?? "No matches",
            content,
            columns,
            rows,
            offset: state.previewOffset,
          });
          lines = frame.lines;
          previewOffset = frame.offset;
          previewPageSize = frame.pageSize;
        } else {
          lines = renderedLines(
            state,
            Math.max(1, Math.min(AUTOCOMPLETE_MAX_ITEMS, (rows || 24) - 3)),
          );
          if (columns > 0) lines = lines.map((line) => fitTerminalLine(line, columns));
        }
        renderedCount = lines.length;
        return `\u001b[?25l${lines.join("\n")}`;
      });
    },
    process: (input, state) => {
      const visible = visibleChoices(state);
      const cursor = Math.min(state.cursor, Math.max(visible.length - 1, 0));
      const next = (updated: typeof initial) =>
        Effect.succeed(
          PromptAction.NextFrame({
            state: {
              ...updated,
              previewOffset:
                updated.cursor !== state.cursor || updated.query !== state.query
                  ? 0
                  : updated.previewOffset,
            },
          }),
        );
      if (input.key.ctrl && input.key.name === "p")
        return items.some((item) => item.preview)
          ? next({ ...state, preview: !state.preview, previewOffset: 0 })
          : Effect.succeed(PromptAction.Beep());
      if (state.preview && (input.key.name === "pageup" || input.key.name === "pagedown"))
        return next({
          ...state,
          previewOffset: Math.max(
            0,
            previewOffset + (input.key.name === "pageup" ? -previewPageSize : previewPageSize),
          ),
        });
      if (input.key.ctrl && input.key.name === "r") {
        const index = visible[cursor];
        if (index === undefined || items[index].removeValue === undefined)
          return Effect.succeed(PromptAction.Beep());
        const removed = new Set(state.removed);
        const selected = new Set(state.selected);
        if (removed.has(index)) removed.delete(index);
        else {
          removed.add(index);
          selected.delete(index);
        }
        return next({ ...state, selected, removed });
      }
      if (input.key.ctrl && input.key.name === "u") return next({ ...state, query: "", cursor: 0 });
      if (input.key.ctrl && input.key.name === "a") {
        const groups = new Set<string>();
        const eligible = items.flatMap((item, index) => {
          if (item.disabled || item.selectExplicitly || state.removed.has(index)) return [];
          if (item.exclusiveGroup && groups.has(item.exclusiveGroup)) return [];
          if (item.exclusiveGroup) groups.add(item.exclusiveGroup);
          return [index];
        });
        const allSelected = eligible.every((index) => state.selected.has(index));
        return next({
          ...state,
          selected: allSelected ? new Set<number>() : new Set(eligible),
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
          const item = items[itemIndex];
          if (item.disabled) return Effect.succeed(PromptAction.Beep());
          if (selected.has(itemIndex)) selected.delete(itemIndex);
          else {
            if (item.exclusiveGroup)
              for (const index of selected) {
                if (items[index].exclusiveGroup === item.exclusiveGroup) selected.delete(index);
              }
            selected.add(itemIndex);
          }
          const removed = new Set(state.removed);
          removed.delete(itemIndex);
          return next({ ...state, selected, removed });
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
              value: [...state.selected, ...state.removed]
                .sort((left, right) => left - right)
                .map((index) =>
                  state.removed.has(index) ? items[index].removeValue! : items[index].value,
                ),
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
    clear: () => Effect.succeed(eraseRenderedLines(renderedCount)),
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
