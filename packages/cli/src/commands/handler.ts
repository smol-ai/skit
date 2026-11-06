import { Cause, Effect, Layer } from "effect";
import { registryHttpLayer } from "../registry/registry-http.js";
import { skitLayer, SkitConfiguration } from "@smolai/skit-core/platform";

import { commandFailure } from "./failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import { authorWorkspaceLayer, authorLayer } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { terminalPrompterLayer } from "../terminal/prompter.js";
import { terminalLibraryProgressLayer } from "../library/update.js";

/** Every command runs with the terminal's prompts and progress; a command never provides them. */
const withTerminal = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.provide(terminalPrompterLayer), Effect.provide(terminalLibraryProgressLayer));

/** The `--home` a command was given selects its configuration; the handler provides it once. */
const configured = <A, E, R>(program: Effect.Effect<A, E, R>, home: string | undefined) =>
  program.pipe(Effect.provide(skitConfigurationLayer(home)));

/**
 * The executable's one Library construction: unrouted, for commands whose operations do not
 * install. Operations that install route their own Library from the configuration they are given.
 */
export const libraryApplicationLayer = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.mergeAll(
      Library.layer({ home: paths.skitHome, routing: { _tag: "None" } }),
      // Removing an authored Collection marks its workspace (A15); `author init` registers one.
      authorWorkspaceLayer,
    ).pipe(Layer.provideMerge(skitLayer)),
  ),
);

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
      authorLayer({ home: paths.skitHome }),
    ).pipe(Layer.provideMerge(skitLayer)),
  ),
);

/** Combined domain services consume the same required configuration snapshot. */
export const sourceApplicationLayer = Layer.merge(
  libraryApplicationLayer,
  registryApplicationLayer,
);

/** Keep requirements inferred until the selected composition boundary supplies them. */
export function handlePlatformCommand<E, R>(
  program: Effect.Effect<void, E, R>,
  home: string | undefined,
) {
  return configured(
    renderCommandFailures(Effect.scoped(withTerminal(program))).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
    ),
    home,
  );
}

/**
 * Building the Library layer can fail (it migrates a legacy state.json under the home lock), so it
 * is built inside the failure renderer.
 */
export function handleLibraryCommand<E, R>(
  program: Effect.Effect<void, E, R>,
  home: string | undefined,
) {
  return configured(
    renderCommandFailures(
      Effect.scoped(withTerminal(program)).pipe(Effect.provide(libraryApplicationLayer)),
    ),
    home,
  );
}

export function handleRegistryCommand<E, R>(
  program: Effect.Effect<void, E, R>,
  home: string | undefined,
) {
  return configured(
    renderCommandFailures(Effect.scoped(withTerminal(program))).pipe(
      Effect.provide(registryApplicationLayer),
    ),
    home,
  );
}

export function handleSourceCommand<E, R>(
  program: Effect.Effect<void, E, R>,
  home: string | undefined,
) {
  return configured(
    renderCommandFailures(
      Effect.scoped(withTerminal(program)).pipe(Effect.provide(sourceApplicationLayer)),
    ),
    home,
  );
}

export { commandFailure } from "./failure-classification.js";
