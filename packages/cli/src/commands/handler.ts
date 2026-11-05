import { Cause, Effect, Layer } from "effect";
import { registryHttpLayer } from "../registry/registry-http.js";
import { skitLayer, SkitConfiguration } from "@smolai/skit-core/platform";
import { libraryApplicationLayer } from "../library/layer.js";

import { commandFailure } from "./failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import { AuthorWorkspace, AuthorHistory } from "@smolai/skit-core/author";

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

const registryApplicationLayer = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.mergeAll(
      registryHttpLayer(),
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
export { libraryApplicationLayer } from "../library/layer.js";
