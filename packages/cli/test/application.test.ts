import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { commandFailure, renderCommandFailures } from "../src/application.js";
import { Conflict } from "../src/presentation/command-errors.js";
import { Renderer, consoleRenderer } from "../src/presentation/renderer.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";

it.effect("presentation retains primary and cleanup failures", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.fail(new Conflict({ message: "Registry rejected" })).pipe(
        Effect.ensuring(Effect.die(new Error("temporary cleanup failed"))),
      ),
    );
    const failure = Exit.match(exit, {
      onFailure: commandFailure,
      onSuccess: () => undefined,
    });
    expect(failure).toMatchObject({
      code: "CONFLICT",
      exitCode: 12,
      message: "Registry rejected\ntemporary cleanup failed",
    });
  }),
);

it.effect("presentation waits for cleanup and reports its defect after interruption", () =>
  Effect.gen(function* () {
    const interaction = yield* makeScriptedInteraction([]);
    const acquired = yield* Deferred.make<void>();
    let cleaned = false;
    const fiber = yield* renderCommandFailures(
      Effect.acquireRelease(Deferred.succeed(acquired, undefined), () =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              cleaned = true;
            }),
          ),
          Effect.andThen(Effect.die(new Error("cleanup failed"))),
        ),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped),
    ).pipe(Effect.provide(interaction.layer), Effect.forkChild);

    yield* Deferred.await(acquired);
    yield* Fiber.interrupt(fiber);

    expect(cleaned).toBe(true);
    const failures = yield* interaction.failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: "OPERATION_FAILED",
      exitCode: 1,
      message: "cleanup failed",
    });
  }),
);

it.effect("interruption is not rendered as a command error", () =>
  Effect.gen(function* () {
    let rendered = false;
    const exit = yield* Effect.exit(
      renderCommandFailures(Effect.interrupt).pipe(
        Effect.provideService(Renderer, {
          ...consoleRenderer(true),
          failure: () =>
            Effect.sync(() => {
              rendered = true;
            }),
        }),
      ),
    );
    expect(rendered).toBe(false);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }),
);
