import { Cause, Effect, Layer } from "effect";
import { registryHttpLayer } from "./registry/registry-http.js";
import { registryAuthLayer } from "./registry/auth-service.js";
import { skitLayer } from "@smolai/skit-core";
import { libraryApplicationFromPaths } from "./library-application/layers.js";
import { skitPathsLayer, SkitPaths } from "./configuration/paths.js";
import { commandFailure } from "./failure-classification.js";
import { Renderer, consoleRendererLayer } from "./presentation/renderer.js";

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

export const registryApplicationFromPaths = Layer.unwrap(
  Effect.map(SkitPaths, (paths) =>
    Layer.merge(registryHttpLayer(), registryAuthLayer(paths.skitHome)).pipe(
      Layer.provideMerge(skitLayer),
    ),
  ),
);

export const registryApplicationLayer = (home?: string) =>
  registryApplicationFromPaths.pipe(Layer.provideMerge(skitPathsLayer(home)));

/** Combined domain services consume the same required path snapshot. */
export const sourceApplicationFromPaths = Layer.merge(
  libraryApplicationFromPaths,
  registryApplicationFromPaths,
);

export const sourceApplicationLayer = (home: string) =>
  sourceApplicationFromPaths.pipe(Layer.provideMerge(skitPathsLayer(home)));

/** Full environment for contract generators and runners exercising multiple command families. */
export function commandApplicationLayer(json: boolean, home: string) {
  return Layer.merge(sourceApplicationLayer(home), consoleRendererLayer(json));
}

/** Keep requirements inferred until the selected composition boundary supplies them. */
export function handlePlatformCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(Effect.provide(skitLayer));
}

export function handleLibraryCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(libraryApplicationFromPaths),
  );
}

export function handleRegistryCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(registryApplicationFromPaths),
  );
}

export function handleSourceCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(sourceApplicationFromPaths),
  );
}

export { commandFailure } from "./failure-classification.js";
export { libraryApplicationLayer } from "./library-application/layers.js";
