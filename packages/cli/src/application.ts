import { Cause, Effect, Layer } from "effect";
import { registryHttpLayer } from "./registry/registry-http.js";
import { registryAuthLayer } from "./registry/auth-service.js";
import { skitLayer } from "@smolai/skit-core";
import { libraryApplicationLayer } from "./library/application/layers.js";
import { skitConfigurationLayer, SkitConfiguration } from "@smolai/skit-core";
import { commandFailure } from "./failure-classification.js";
import { Renderer, consoleRendererLayer } from "./presentation/renderer.js";
import { AuthorWorkspace } from "./author/workspace.js";
import { AuthorHistory } from "./author/history.js";

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
    Layer.mergeAll(
      registryHttpLayer(),
      registryAuthLayer(paths.skitHome),
      // One author layer per runtime: AuthorHistory over AuthorWorkspace, built once, so one
      // journal permit guards this home (A9).
      AuthorHistory.layer({ home: paths.skitHome }).pipe(Layer.provideMerge(AuthorWorkspace.layer)),
    ).pipe(Layer.provideMerge(skitLayer)),
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
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(AuthorWorkspace.layer.pipe(Layer.provideMerge(skitLayer))),
  );
}

/**
 * Building the Library layer can fail (it migrates a legacy state.json under the home lock), so it
 * is built inside the failure renderer.
 */
export function handleLibraryCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(
    Effect.scoped(program).pipe(Effect.provide(libraryApplicationLayer)),
  );
}

export function handleRegistryCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program)).pipe(
    Effect.provide(registryApplicationLayer),
  );
}

export function handleSourceCommand<E, R>(program: Effect.Effect<void, E, R>) {
  return renderCommandFailures(Effect.scoped(program).pipe(Effect.provide(sourceApplicationLayer)));
}

export { commandFailure } from "./failure-classification.js";
export { libraryApplicationLayer } from "./library/application/layers.js";
