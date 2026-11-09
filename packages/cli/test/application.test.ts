import { Layer, Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { commandFailure } from "../src/commands/failure-classification.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { Command } from "effect/cli";
import { NodeServices } from "@effect/platform-node";
import { RegistryRejectedWrite } from "../src/registry/failures.js";
import { Renderer } from "../src/terminal/renderer.js";
import { consoleRenderer } from "../src/terminal/console-renderer.js";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";

it.effect("presentation retains primary and cleanup failures", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.fail(new RegistryRejectedWrite({ detail: "Registry rejected" })).pipe(
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
      message: "Registry rejected\nAdditional failure: temporary cleanup failed",
    });
  }),
);

it.effect("presentation waits for cleanup and reports its defect after interruption", () =>
  Effect.gen(function* () {
    const interaction = yield* makeScriptedInteraction([]);
    const imported = yield* Deferred.make<void>();
    let cleaned = false;
    const command = Command.make("cleanup", {}, () =>
      Effect.acquireRelease(Deferred.succeed(imported, undefined), () =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              cleaned = true;
            }),
          ),
          Effect.andThen(Effect.die(new Error("cleanup failed"))),
        ),
      ).pipe(Effect.andThen(Effect.never)),
    );
    const fiber = yield* runCommandTree(command, [], "test").pipe(
      Effect.provide(interaction.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.forkChild,
    );

    yield* Deferred.await(imported);
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
      runCommandTree(
        Command.make("interrupt", {}, () => Effect.interrupt),
        [],
        "test",
      ).pipe(
        Effect.provide(NodeServices.layer),
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

it.effect("Presenter routes help, version and parse errors only through the renderer", () =>
  Effect.gen(function* () {
    const interaction = yield* makeScriptedInteraction([]);
    let handled = 0;
    const child = Command.make("run", {}, () =>
      Effect.sync(() => {
        handled++;
      }),
    );
    const command = Command.make("skit").pipe(Command.withSubcommands([child]));
    const run = (args: readonly string[]) =>
      runCommandTree(command, args, "1.2.3").pipe(
        Effect.provide(interaction.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      );
    const help = run(["--help"]);
    yield* help;
    yield* help;
    yield* run([]);
    yield* run(["--version"]);
    yield* run(["--completions", "bash"]);
    yield* run(["--completions", "pwsh"]);
    yield* run(["--unknown"]);
    yield* run(["run"]);
    const events = yield* interaction.events;
    expect(events.filter((event) => event._tag === "Help")).toHaveLength(3);
    expect(yield* interaction.results).toMatchObject([
      { schema: "skit.version.v1", data: { version: "1.2.3" } },
      { schema: "skit.completions.v1", data: { shell: "bash", script: expect.any(String) } },
      { schema: "skit.completions.v1", data: { shell: "powershell", script: expect.any(String) } },
    ]);
    expect(yield* interaction.failures).toMatchObject([{ code: "INVALID_ARGUMENT", exitCode: 64 }]);
    expect(handled).toBe(1);
  }),
);
