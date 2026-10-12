import { Cause, Effect, Layer } from "effect";
import { registryHttpLayer } from "./registry/registry-http.js";
import { registryAuthLayer } from "./registry/auth-service.js";
import { skitLayer } from "@smolai/skit-core";
import { libraryApplicationLayer } from "./library-application/layers.js";
import { configurationPaths, SkitPaths } from "./configuration/paths.js";
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

export function registryApplicationLayer(home?: string) {
  return Layer.unwrap(
    Effect.map(configurationPaths(home), (paths) =>
      Layer.mergeAll(
        registryHttpLayer(),
        registryAuthLayer(paths.skitHome),
        Layer.succeed(SkitPaths, paths),
      ).pipe(Layer.provideMerge(skitLayer)),
    ),
  );
}

/** Combined environment for acquisition and synchronization, which need both domains. */
export function sourceApplicationLayer(home: string) {
  return Layer.unwrap(
    Effect.map(configurationPaths(home), (paths) =>
      Layer.merge(
        libraryApplicationLayer(paths.skitHome),
        registryApplicationLayer(paths.skitHome),
      ).pipe(Layer.provideMerge(Layer.succeed(SkitPaths, paths))),
    ),
  );
}

/** Full environment for contract generators and runners exercising multiple command families. */
export function commandApplicationLayer(json: boolean, home: string) {
  return Layer.merge(sourceApplicationLayer(home), consoleRendererLayer(json));
}

/** Keep requirements inferred until the selected composition boundary supplies them. */
export function handlePlatformCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(Effect.provide(skitLayer));
}

export function handleLibraryCommand<E, R>(program: Effect.Effect<void, E, R>, home: string) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(libraryApplicationLayer(home)),
  );
}

export function handleRegistryCommand<E, R>(program: Effect.Effect<void, E, R>, home?: string) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(registryApplicationLayer(home)),
  );
}

export function handleSourceCommand<E, R>(program: Effect.Effect<void, E, R>, home: string) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(sourceApplicationLayer(home)),
  );
}

export { commandFailure } from "./failure-classification.js";
export { libraryApplicationLayer } from "./library-application/layers.js";
