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
  | "a"
  | "c"
  | "o"
  | "d"
  | "e"
  | "x";

const press = (key: Key): Terminal.UserInput => {
  const ctrl = key === "ctrl+a";
  const name = ctrl ? "a" : key;
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
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("the terminal prompter", () => {
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
