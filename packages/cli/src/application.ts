import { homedir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Layer, Runtime } from "effect";
import { registryHttpLayer } from "./registry/registry-http.js";
import { registryAuthLayer } from "./registry/auth-service.js";
import { NodeRuntime } from "@effect/platform-node";
import {
  skitLayer,
  libraryStoreLayer,
  libraryAuditLogLayer,
  withLibraryWriter,
} from "@smolai/skit-core";
import { classifyFailure } from "./failure-classification.js";
import { errorMessage } from "./presentation/command-errors.js";
import { Renderer, consoleRendererLayer } from "./presentation/renderer.js";
import type { CommandFailure } from "./commands/types.js";

/** The presentation boundary consumes a Cause only after the operation's scopes close. */
export function commandFailure<E>(cause: Cause.Cause<E>): CommandFailure {
  const errors = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
  );
  const first = errors[0];
  const failure = classifyFailure(first);
  return {
    ...failure,
    message: errors.length > 1 ? errors.map(errorMessage).join("\n") : failure.message,
  };
}

export function renderCommandFailures<A, E, R>(program: Effect.Effect<A, E, R>) {
  return Effect.uninterruptibleMask((restore) =>
    restore(program).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.flatMap(Renderer, (renderer) => renderer.failure(commandFailure(cause))),
      ),
    ),
  );
}

export function applicationLayer(home: string) {
  return Layer.mergeAll(
    skitLayer,
    registryHttpLayer(),
    registryAuthLayer(home).pipe(Layer.provide(skitLayer)),
    libraryStoreLayer({ home }).pipe(Layer.provide(skitLayer)),
    libraryAuditLogLayer({ home }).pipe(Layer.provide(skitLayer)),
  );
}

/** Complete command environment for non-entrypoint runners such as tests and generators. */
export function commandApplicationLayer(json: boolean, home: string) {
  return Layer.merge(applicationLayer(home), consoleRendererLayer(json));
}

/** Services supplied by the real CLI composition root. */
export type ApplicationServices = Layer.Success<ReturnType<typeof applicationLayer>> | Renderer;

/** Close one parsed command over the application services selected by its flags. */
export function handleCommand<E>(
  program: Effect.Effect<void, E, ApplicationServices>,
  home: string = process.env.SKIT_HOME ?? join(homedir(), ".skit"),
) {
  return renderCommandFailures(withLibraryWriter(Effect.scoped(program))).pipe(
    Effect.provide(applicationLayer(home)),
  );
}

/** Close a diagnostic/preview command without acquiring the mutating Library writer lock. */
export function handleReadOnlyCommand<E>(
  program: Effect.Effect<void, E, ApplicationServices>,
  home: string = process.env.SKIT_HOME ?? join(homedir(), ".skit"),
) {
  return renderCommandFailures(Effect.scoped(program)).pipe(Effect.provide(applicationLayer(home)));
}
/**
 * The sole process runner. NodeRuntime interrupts the root fiber on SIGINT/SIGTERM,
 * waits for finalization, and returns 130 for interruption. Command-selected exit codes
 * remain on process.exitCode after successful rendering.
 */
export function runCli<E>(
  program: Effect.Effect<void, E, ApplicationServices>,
  json: boolean,
  home: string = process.env.SKIT_HOME ?? join(homedir(), ".skit"),
): void {
  NodeRuntime.runMain(
    renderCommandFailures(withLibraryWriter(Effect.scoped(program))).pipe(
      Effect.provide(commandApplicationLayer(json, home)),
    ),
    {
      disableErrorReporting: true,
      teardown: (exit, onExit) =>
        Runtime.defaultTeardown(exit, (code) => onExit(Number(process.exitCode ?? 0) || code)),
    },
  );
}
