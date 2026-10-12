import { Cause, Effect, Layer } from "effect";
import { registryHttpLayer } from "./registry/registry-http.js";
import { registryAuthLayer } from "./registry/auth-service.js";
import { skitLayer } from "@smolai/skit-core";
import { libraryApplicationFromConfiguration } from "./library-application/layers.js";
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

export const registryApplicationFromConfiguration = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.merge(registryHttpLayer(), registryAuthLayer(paths.skitHome)).pipe(
      Layer.provideMerge(skitLayer),
    ),
  ),
);

export const registryApplicationLayer = (home?: string) =>
  registryApplicationFromConfiguration.pipe(Layer.provideMerge(skitConfigurationLayer(home)));

/** Combined domain services consume the same required path snapshot. */
export const sourceApplicationFromConfiguration = Layer.merge(
  libraryApplicationFromConfiguration,
  registryApplicationFromConfiguration,
);

export const sourceApplicationLayer = (home: string) =>
  sourceApplicationFromConfiguration.pipe(Layer.provideMerge(skitConfigurationLayer(home)));

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
    Effect.provide(libraryApplicationFromConfiguration),
  );
}

export function handleRegistryCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(registryApplicationFromConfiguration),
  );
}

export function handleSourceCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(sourceApplicationFromConfiguration),
  );
}

export { commandFailure } from "./failure-classification.js";
export { libraryApplicationLayer } from "./library-application/layers.js";
