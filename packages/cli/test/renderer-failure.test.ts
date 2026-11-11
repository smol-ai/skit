// The Renderer emits typed facts in the versioned JSON error envelope.

import { afterEach, describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { consoleRenderer } from "../src/terminal/console-renderer.js";
import type { CommandFailure } from "../src/commands/types.js";
import { describeFailure } from "../src/terminal/failure.js";

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(((
    _chunk: unknown,
    callback?: unknown,
  ) => {
    if (typeof callback === "function") (callback as () => void)();
    return true;
  }) as never);
}

const render = (failure: CommandFailure, json: boolean) => consoleRenderer(json).failure(failure);

describe("failure rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.effect("emits native diagnostic causes in the v2 JSON envelope", () =>
    Effect.gen(function* () {
      const write = captureStderr();

      yield* render(
        {
          code: "CONFLICT",
          cause: Cause.fail(new Error("Projection failed")),
          ...describeFailure({ summary: ["Projection failed"], next: ["Run skit doctor."] }),
        },
        true,
      );

      expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
        schema: "skit.error.v2",
        error: {
          code: "CONFLICT",
          cause: [{ _tag: "Fail", error: { name: "Error", message: "Projection failed" } }],
        },
      });
    }),
  );

  it.effect("sets the process exit code from the failure", () =>
    Effect.gen(function* () {
      captureStderr();
      yield* render(
        {
          code: "NOT_FOUND",
          cause: Cause.fail(new Error("gone")),
          ...describeFailure({ summary: ["gone"], next: ["add it"] }),
        },
        true,
      );
      expect(process.exitCode).toBe(1);
    }),
  );
});

it.effect.each(["stdout", "stderr"] as const)(
  "terminal %s callback failures do not report success",
  (channel) =>
    Effect.gen(function* () {
      const error = new Error("injected terminal write failure");
      const spy = vi.spyOn(process[channel], "write").mockImplementation(((
        _body: unknown,
        callback: (error?: Error) => void,
      ) => {
        callback(error);
        return false;
      }) as never);
      const renderer = consoleRenderer(false);
      const operation =
        channel === "stdout"
          ? renderer.help("help")
          : renderer.failure({
              code: "NOT_FOUND",
              cause: Cause.fail(new Error("missing")),
              ...describeFailure({ summary: ["missing"], next: ["retry"] }),
            });
      const exit = yield* Effect.exit(operation).pipe(
        Effect.ensuring(Effect.sync(() => spy.mockRestore())),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(error);
      expect(process.exitCode).toBeUndefined();
    }),
);
