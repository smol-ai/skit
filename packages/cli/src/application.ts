import { Cause, Effect, Layer } from "effect";
import { consoleRendererLayer } from "./terminal/console-renderer.js";
import { registryHttpLayer } from "./registry/registry-http.js";
import { skitLayer, SkitConfiguration } from "@smolai/skit-core/platform";

import { commandFailure } from "./commands/failure-classification.js";
import { Renderer } from "./terminal/renderer.js";
import { authorWorkspaceLayer, authorLayer } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { inventoryRootOptions } from "@smolai/skit-core/library/routing";
import { rootOverrides, type RootFlags } from "./commands/parameters.js";
import { Option } from "effect";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { terminalPrompterLayer } from "./terminal/prompter.js";
import { terminalLibraryProgressLayer } from "./library/update/present-progress.js";

/** Every command runs with the terminal's prompts and progress; a command never provides them. */
const withTerminal = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.provide(terminalPrompterLayer), Effect.provide(terminalLibraryProgressLayer));

/** The flags every command may carry: `--home` selects its configuration, root flags its device roots. */
export type CommandInput = { readonly home: Option.Option<string> } & Partial<RootFlags>;

/** The `--home` a command was given selects its configuration; the handler provides it once. */
const configured = <A, E, R>(program: Effect.Effect<A, E, R>, input: CommandInput) =>
  program.pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home))));

/**
 * The executable's one Library construction, routed from this device's roots and the command's
 * root flags. Operations never construct a Library.
 */
export const libraryApplicationLayer = (input: Partial<RootFlags> = {}) =>
  Layer.unwrap(
    Effect.map(SkitConfiguration, (paths) =>
      Layer.mergeAll(
        Library.layer({
          home: paths.skitHome,
          roots: inventoryRootOptions(paths, rootOverrides(input)),
        }),
        // `author init` registers a workspace under its lease.
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
export const sourceApplicationLayer = (input: Partial<RootFlags> = {}) =>
  Layer.merge(libraryApplicationLayer(input), registryApplicationLayer);

/** Keep requirements inferred until the selected composition boundary supplies them. */
export function handlePlatformCommand<E, R>(
  program: Effect.Effect<void, E, R>,
  input: CommandInput,
) {
  return configured(
    renderCommandFailures(Effect.scoped(withTerminal(program))).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
    ),
    input,
  );
}

/**
 * Building the Library layer can fail (it migrates a legacy state.json under the home lock), so it
 * is built inside the failure renderer.
 */
export function handleLibraryCommand<E, R>(
  program: Effect.Effect<void, E, R>,
  input: CommandInput,
) {
  return configured(
    renderCommandFailures(
      Effect.scoped(withTerminal(program)).pipe(Effect.provide(libraryApplicationLayer(input))),
    ),
    input,
  );
}

export function handleRegistryCommand<E, R>(
  program: Effect.Effect<void, E, R>,
  input: CommandInput,
) {
  return configured(
    renderCommandFailures(Effect.scoped(withTerminal(program))).pipe(
      Effect.provide(registryApplicationLayer),
    ),
    input,
  );
}

export function handleSourceCommand<E, R>(program: Effect.Effect<void, E, R>, input: CommandInput) {
  return configured(
    renderCommandFailures(
      Effect.scoped(withTerminal(program)).pipe(Effect.provide(sourceApplicationLayer(input))),
    ),
    input,
  );
}

export { commandFailure } from "./commands/failure-classification.js";

/** Full environment for contract generators and runners exercising multiple command families. */
export function commandApplicationLayer(json: boolean, home: string) {
  return Layer.merge(
    sourceApplicationLayer().pipe(Layer.provideMerge(skitConfigurationLayer(home))),
    consoleRendererLayer(json),
  );
}
