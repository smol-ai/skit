// The failure envelope callers parse. These moved from dispatch's writeFailure to the Renderer
// that replaced it; the assertions are unchanged, because the bytes must be.

import { afterEach, describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { consoleRenderer } from "../src/presentation/renderer.js";
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
