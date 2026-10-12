import { Cause, Effect, Layer } from "effect";
import { registryHttpLayer } from "./registry/registry-http.js";
import { registryAuthLayer } from "./registry/auth-service.js";
import { skitLayer } from "@smolai/skit-core";
import { libraryApplicationLayer } from "./library-application/layers.js";
import { skitConfigurationLayer, SkitConfiguration } from "./configuration/skit-configuration.js";
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

export const registryApplicationLayer = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.merge(registryHttpLayer(), registryAuthLayer(paths.skitHome)).pipe(
      Layer.provideMerge(skitLayer),
    ),
  ),
);

/** Combined domain services consume the same required configuration snapshot. */
export const sourceApplicationLayer = Layer.merge(
  libraryApplicationLayer,
  registryApplicationLayer,
);

/** Full environment for contract generators and runners exercising multiple command families. */
export function commandApplicationLayer(json: boolean, home: string) {
  return Layer.merge(
    sourceApplicationLayer.pipe(Layer.provideMerge(skitConfigurationLayer(home))),
    consoleRendererLayer(json),
  );
}

/** Keep requirements inferred until the selected composition boundary supplies them. */
export function handlePlatformCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(Effect.provide(skitLayer));
}

export function handleLibraryCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(libraryApplicationLayer),
  );
}

export function handleRegistryCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(registryApplicationLayer),
  );
}

export function handleSourceCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(Effect.provide(sourceApplicationLayer));
}

export { commandFailure } from "./failure-classification.js";
export { libraryApplicationLayer } from "./library-application/layers.js";
