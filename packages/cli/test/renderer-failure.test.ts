// The failure envelope callers parse. These moved from dispatch's writeFailure to the Renderer
// that replaced it; the assertions are unchanged, because the bytes must be.

import { afterEach, describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { consoleRenderer } from "../src/terminal/console-renderer.js";
import type { CommandFailure } from "../src/commands/types.js";

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

  it.effect("keeps ordinary JSON failures byte-shape compatible", () =>
    Effect.gen(function* () {
      const write = captureStderr();

      yield* render(
        {
          code: "CONFLICT",
          exitCode: 12,
          message: "Projection failed",
          remediation: "Run skit doctor.",
        },
        true,
      );

      expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
        schema: "skit.error.v1",
        error: {
          code: "CONFLICT",
          message: "Projection failed",
          remediation: "Run skit doctor.",
        },
      });
    }),
  );

  it.effect("sets the process exit code from the failure", () =>
    Effect.gen(function* () {
      captureStderr();
      yield* render(
        { code: "NOT_FOUND", exitCode: 11, message: "gone", remediation: "add it" },
        true,
      );
      expect(process.exitCode).toBe(11);
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
              exitCode: 11,
              message: "missing",
              remediation: "retry",
            });
      const exit = yield* Effect.exit(operation).pipe(
        Effect.ensuring(Effect.sync(() => spy.mockRestore())),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(error);
      expect(process.exitCode).toBeUndefined();
    }),
);
