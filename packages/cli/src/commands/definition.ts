import { Context, type Effect } from "effect";
import { Command, type Param } from "effect/cli";

/** Keep the executable parameters available to documentation without Effect's private command API. */
export const CommandParameters = Context.Service<never, Command.Command.Config>(
  "skit/cli/CommandParameters",
);
export const GlobalParameters = Context.Service<
  never,
  readonly { readonly flag: Param.Any; readonly _tag: "Action" | "Setting" }[]
>("skit/cli/GlobalParameters");
export const SharedParameters = Context.Service<never, Command.Command.FlagConfig>(
  "skit/cli/SharedParameters",
);

export function defineCommand<
  Name extends string,
  const Config extends Command.Command.Config,
  E,
  R,
>(
  name: Name,
  config: Config,
  handler: (input: Command.Command.Config.Infer<Config>) => Effect.Effect<void, E, R>,
) {
  return Command.make(name, config, handler).pipe(Command.annotate(CommandParameters, config));
}

/** Shared flags retain their declaring scope as well as their parser definitions. */
export function withSharedFlags<const Config extends Command.Command.FlagConfig>(config: Config) {
  return <Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ) => command.pipe(Command.withSharedFlags(config), Command.annotate(SharedParameters, config));
}
