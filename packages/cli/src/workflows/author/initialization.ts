import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleLibraryCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags } from "../../commands/parameters.js";
import { result } from "../../handlers/contracts.js";
import { Renderer } from "../../presentation/renderer.js";
import { ensureAuthorWorkspaceRegistered } from "../../library/author-workspace.js";

export const authorInitCommand = Effect.fn("CLI.authorInit")(function* (
  input: string,
  register: boolean,
) {
  const result = yield* ensureAuthorWorkspaceRegistered(input, { register, scaffold: true });
  const initialized = yield* Effect.fromNullishOr(result.initialized).pipe(Effect.orDie);
  return { initialized, entry: result.entry };
});

const path = Argument.String("path").pipe(Argument.optional);
const register = Flag.Boolean("register").pipe(
  Flag.withDescription("Re-register a previously removed Author Workspace Library Entry."),
  Flag.withDefault(false),
);

export const authorInitCliCommand = Command.make(
  "init",
  { path, register, ...localFlags },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const { initialized: value, entry } = yield* authorInitCommand(
          Option.getOrElse(input.path, () => "."),
          input.register,
        );
        const output = {
          ...value,
          library_registration: entry ? ("registered" as const) : ("removed" as const),
        };
        yield* renderer.result(result("init", output));
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription("Initialize SKIT authoring in a new or existing Skill Collection."),
  Command.withExamples([
    { command: "skit author init" },
    { command: "skit author init ./my-tools" },
    { command: "skit author init --register" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.init],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
