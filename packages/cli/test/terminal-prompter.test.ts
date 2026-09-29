// The real Prompter, driven through a scripted Terminal.
//
// The scripted Prompter covers the flows that ask questions; nothing covered the implementation
// that answers them. These drive Effect's own prompt loop with synthetic key input, so the
// choice mapping, the cancellation contract and the stderr guarantee are all executable.

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Layer, Option, Queue, Terminal } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import { Prompter, terminalPrompterLayer, type Choice } from "../src/presentation/prompter.js";

type Key =
  | "up"
  | "down"
  | "enter"
  | "space"
  | "escape"
  | "ctrl+a"
  | "ctrl+r"
  | "ctrl+p"
  | "pageup"
  | "pagedown"
  | "a"
  | "c"
  | "o"
  | "d"
  | "e"
  | "x";

const press = (key: Key): Terminal.UserInput => {
  const ctrl = key.startsWith("ctrl+");
  const name = ctrl ? key.slice(5) : key;
  return {
    input: ctrl ? Option.none() : Option.some(name),
    key: { name, ctrl, meta: false, shift: false },
  };
};

/**
 * A Terminal that replays a fixed key sequence.
 *
 * Only input is scripted: the Prompter redirects drawing to stderr itself, so this display is
 * never reached and the stderr guarantee is asserted with a spy instead.
 */
const scriptedTerminal = (keys: readonly Key[]): Terminal.Terminal =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.gen(function* () {
      const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>();
      for (const key of keys) yield* Queue.offer(queue, press(key));
      // Ending the queue is how the loop learns input is exhausted; an unanswered prompt then
      // quits rather than hanging the test.
      yield* Queue.end(queue);
      return queue;
    }),
    readLine: Effect.succeed(""),
    display: () => Effect.void,
  });

/** The prompter under test, over a terminal that answers with `keys`. */
const promptedWith = (keys: readonly Key[]) =>
  terminalPrompterLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Terminal.Terminal)(scriptedTerminal(keys)),
        NodeFileSystem.layer,
        NodePath.layer,
      ),
    ),
  );

const harnesses: Choice<"claude" | "codex" | "opencode">[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex", hint: "experimental" },
  { value: "opencode", label: "opencode" },
];

// Prompts draw real escape sequences; keep them out of the reporter's output.
let stderr: MockInstance<typeof process.stderr.write>;
beforeEach(() => {
  vi.stubEnv("FORCE_COLOR", "0");
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the terminal prompter", () => {
  const removable = [
    { value: "keep", label: "Keep", selected: true, removeValue: "remove-keep" },
    { value: "other", label: "Other", removeValue: "remove-other" },
  ];
  it.effect("marks removal explicitly and bulk selection preserves it", () =>
    Effect.gen(function* () {
      const chosen = yield* (yield* Prompter).multiselect("Manage skills", removable);
      expect(chosen).toEqual(["remove-keep", "other"]);
      expect(stderr.mock.calls.map(([frame]) => String(frame)).join("\n")).toContain(
        "✕ Keep  · Remove",
      );
    }).pipe(Effect.provide(promptedWith(["ctrl+r", "ctrl+a", "enter"]))),
  );
  it.effect("can undo removal or change it back to selection", () =>
    Effect.gen(function* () {
      const chosen = yield* (yield* Prompter).multiselect("Manage skills", removable);
      expect(chosen).toEqual(["keep"]);
    }).pipe(Effect.provide(promptedWith(["ctrl+r", "ctrl+r", "space", "enter"]))),
  );
  it.effect("Space changes a removal mark back to selection", () =>
    Effect.gen(function* () {
      const chosen = yield* (yield* Prompter).multiselect("Manage skills", removable);
      expect(chosen).toEqual(["keep"]);
    }).pipe(Effect.provide(promptedWith(["ctrl+r", "space", "enter"]))),
  );
  it.effect("ordinary pickers do not accept removal actions", () =>
    Effect.gen(function* () {
      const chosen = yield* (yield* Prompter).multiselect("Pick harnesses", harnesses);
      expect(chosen).toEqual([]);
    }).pipe(Effect.provide(promptedWith(["ctrl+r", "enter"]))),
  );
  it.effect("loads content lazily and caches it while preserving selection", () =>
    Effect.gen(function* () {
      const load = vi.fn(() => Effect.succeed("# Review code\nRead carefully."));
      const other = vi.fn(() => Effect.succeed("# Lint code"));
      const chosen = yield* (yield* Prompter).multiselect("Pick skills", [
        { value: "review", label: "Review", selected: true, preview: load },
        { value: "lint", label: "Lint", preview: other },
      ]);
      expect(chosen).toEqual(["review"]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
      const frames = stderr.mock.calls.map(([frame]) => String(frame)).join("\n");
      expect(frames).toContain("# Review code");
      expect(frames).toContain("# Lint code");
      expect(frames).toContain("Ctrl+P preview");
    }).pipe(
      Effect.provide(promptedWith(["ctrl+p", "ctrl+p", "ctrl+p", "down", "ctrl+p", "enter"])),
    ),
  );
  it.effect("does not read preview content when the pane stays closed", () =>
    Effect.gen(function* () {
      const load = vi.fn(() => Effect.succeed("Secret fixture content"));
      yield* (yield* Prompter).multiselect("Pick skills", [
        { value: "review", label: "Review", preview: load },
      ]);
      expect(load).not.toHaveBeenCalled();
    }).pipe(Effect.provide(promptedWith(["enter"]))),
  );
  it.effect("scrolls preview pages without changing the highlighted choice", () =>
    Effect.gen(function* () {
      const load = () =>
        Effect.succeed(Array.from({ length: 60 }, (_, index) => `Line ${index + 1}`).join("\n"));
      const chosen = yield* (yield* Prompter).multiselect("Pick skills", [
        { value: "review", label: "Review", selected: true, preview: load },
      ]);
      expect(chosen).toEqual(["review"]);
      const frames = stderr.mock.calls.map(([frame]) => String(frame)).join("\n");
      expect(frames).toContain("Line 15");
      expect(frames).toContain("Lines 1–");
    }).pipe(Effect.provide(promptedWith(["ctrl+p", "pagedown", "pageup", "enter"]))),
  );
  it.effect("colors grouped choices and nests context beneath only the highlighted skill", () =>
    Effect.gen(function* () {
      vi.stubEnv("FORCE_COLOR", "1");
      vi.stubEnv("TERM", "xterm-256color");
      vi.stubEnv("NO_COLOR", undefined);
      const prompter = yield* Prompter;
      yield* prompter.multiselect("Pick skills", [
        {
          value: "review",
          label: "Review",
          group: "Local",
          hint: "modified today",
          detail: "/skills/review",
          selected: true,
        },
        { value: "lint", label: "Lint", group: "Local", detail: "/skills/lint" },
      ]);
      const frame = stderr.mock.calls
        .map(([frame]) => String(frame))
        .find((frame) => frame.includes("modified today"))!;
      expect(frame).toContain("\u001b[36m");
      expect(frame).toContain("\u001b[32m");
      expect(frame).toContain("\u001b[2m");
      // oxlint-disable-next-line no-control-regex -- Strip terminal ANSI styling before asserting layout.
      const plain = frame.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(plain).toContain(
        "  ─ Local\n    ❯ ☒ Review  · modified today\n        /skills/review",
      );
      expect(plain).not.toContain("/skills/lint");
    }).pipe(Effect.provide(promptedWith(["enter"]))),
  );

  it.effect("NO_COLOR suppresses styling even when color is forced", () =>
    Effect.gen(function* () {
      vi.stubEnv("FORCE_COLOR", "1");
      vi.stubEnv("TERM", "xterm-256color");
      vi.stubEnv("NO_COLOR", "1");
      const prompter = yield* Prompter;
      yield* prompter.multiselect("Pick skills", [
        { value: "review", label: "Review", group: "Local" },
      ]);
      const frames = stderr.mock.calls.map(([frame]) => String(frame)).join("");
      // oxlint-disable-next-line no-control-regex -- Ensure terminal ANSI styling is suppressed.
      expect(frames).not.toMatch(/\u001b\[(?:1|2|32|36)m/);
    }).pipe(Effect.provide(promptedWith(["enter"]))),
  );
  it.effect("select returns the highlighted choice", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.select("Pick a harness", harnesses);
      assert.strictEqual(chosen, "codex");
    }).pipe(Effect.provide(promptedWith(["down", "enter"]))),
  );

  it.effect("Ctrl+A selects every choice even when the list is filtered", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick harnesses", harnesses);
      assert.deepStrictEqual(chosen, ["claude", "codex", "opencode"]);
    }).pipe(Effect.provide(promptedWith(["c", "o", "d", "e", "x", "ctrl+a", "enter"]))),
  );

  it.effect("Ctrl+A clears the selection when every choice is selected", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick harnesses", harnesses);
      assert.deepStrictEqual(chosen, []);
    }).pipe(Effect.provide(promptedWith(["ctrl+a", "ctrl+a", "enter"]))),
  );

  it.effect("plain a filters instead of changing the selection", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick harnesses", harnesses);
      assert.deepStrictEqual(chosen, ["claude"]);
    }).pipe(Effect.provide(promptedWith(["a", "space", "enter"]))),
  );

  it.effect("multiselect starts on the first choice", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick harnesses", harnesses);
      assert.deepStrictEqual(chosen, ["claude"]);
    }).pipe(Effect.provide(promptedWith(["space", "enter"]))),
  );

  it.effect("multiselect preserves default selections", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick harnesses", [
        harnesses[0],
        { ...harnesses[1], selected: true },
        harnesses[2],
      ]);
      assert.deepStrictEqual(chosen, ["codex"]);
    }).pipe(Effect.provide(promptedWith(["enter"]))),
  );

  it.effect("multiselect filters choices as the user types", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick harnesses", harnesses);
      assert.deepStrictEqual(chosen, ["codex"]);
    }).pipe(Effect.provide(promptedWith(["c", "o", "d", "e", "x", "space", "enter"]))),
  );

  it.effect("multiselect allows an empty submission", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick harnesses", harnesses);
      assert.deepStrictEqual(chosen, []);
    }).pipe(Effect.provide(promptedWith(["enter"]))),
  );

  it.effect("multiselect filters by source group and skips nonselectable headings", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect("Pick skills", [
        { value: "review", label: "Review", group: "Codex" },
        { value: "lint", label: "Lint", group: "Local" },
      ]);
      assert.deepStrictEqual(chosen, ["review"]);
      expect(stderr.mock.calls.some(([frame]) => String(frame).includes("─ Codex"))).toBe(true);
    }).pipe(Effect.provide(promptedWith(["c", "o", "d", "e", "x", "space", "enter"]))),
  );

  it.effect("group headings fit the page while the highlighted choice stays visible", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const chosen = yield* prompter.multiselect(
        "Pick skills",
        Array.from({ length: 25 }, (_, index) => ({
          value: String(index),
          label: `Skill ${index}`,
          group: `Source ${index}`,
          detail: `/skills/${index}`,
        })),
      );
      assert.deepStrictEqual(chosen, ["24"]);
      const frames = stderr.mock.calls
        .map(([frame]) => String(frame))
        .filter((frame) => frame.startsWith("\u001b[?25l"));
      expect(frames.every((frame) => frame.split("\n").length <= 21)).toBe(true);
      expect(frames.some((frame) => frame.includes("❯ ☐ Skill 24"))).toBe(true);
    }).pipe(Effect.provide(promptedWith(["up", "space", "enter"]))),
  );

  it.effect("Escape identifies back-navigation and ends the abandoned line", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const failure = yield* Effect.flip(prompter.multiselect("Pick harnesses", harnesses));
      assert.strictEqual(failure.reason, "back");
      assert.strictEqual(stderr.mock.calls.at(-1)?.[0], "\n");
    }).pipe(Effect.provide(promptedWith(["escape"]))),
  );

  it.effect("exhausted input cancels rather than hanging", () =>
    Effect.gen(function* () {
      const prompter = yield* Prompter;
      const failure = yield* Effect.flip(prompter.select("Pick a harness", harnesses));
      assert.strictEqual(failure._tag, "PromptCancelled");
      assert.strictEqual(failure.prompt, "Pick a harness");
    }).pipe(Effect.provide(promptedWith([]))),
  );

  it.effect("prompts draw on stderr, never on stdout", () =>
    Effect.gen(function* () {
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const prompter = yield* Prompter;
      yield* prompter.select("Pick a harness", harnesses);
      expect(stderr).toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      assert.include(stderr.mock.calls.map(([text]) => String(text)).join(""), "Claude Code");
    }).pipe(Effect.provide(promptedWith(["enter"]))),
  );
});

it.effect("keeps blocked skills previewable and bulk selection leaves conflicts unresolved", () =>
  Effect.gen(function* () {
    const chosen = yield* (yield* Prompter).multiselect("Choose copies", [
      {
        value: "blocked",
        label: "Invalid marker",
        disabled: true,
        selected: true,
        description: "Used by Claude · blocked",
        preview: () => Effect.succeed("Blocked content"),
      },
      {
        value: "claude",
        label: "Different Claude copy",
        exclusiveGroup: "different",
        selectExplicitly: true,
      },
      {
        value: "codex",
        label: "Different Codex copy",
        exclusiveGroup: "different",
        selectExplicitly: true,
      },
      { value: "normal", label: "Normal" },
    ]);
    expect(chosen).toEqual(["codex", "normal"]);
    const frames = stderr.mock.calls.map(([frame]) => String(frame)).join("\n");
    expect(frames).toContain("Used by Claude · blocked");
    expect(frames).toContain("Blocked content");
  }).pipe(
    Effect.provide(
      promptedWith([
        "space",
        "ctrl+p",
        "ctrl+p",
        "ctrl+a",
        "down",
        "space",
        "down",
        "space",
        "enter",
      ]),
    ),
  ),
);
