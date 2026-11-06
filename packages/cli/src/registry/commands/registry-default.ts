import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { handlePlatformCommand } from "../../application.js";
import { CommandMetadata, credentialStoreSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../../commands/parameters.js";
import { Registry } from "../index.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";

const name = Argument.String("name");

export const registryDefaultCliCommand = Command.make(
  "default",
  { name, home: homeFlag, json: jsonFlag },
  ({ name, home }) =>
    handlePlatformCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;

        const selectedHome = paths.skitHome;
        const renderer = yield* Renderer;
        const value = yield* Registry.remotes.setDefault(name, selectedHome);
        yield* renderer.result(
          result("registryRemote", {
            ...value,
            action: "defaulted",
          }),
        );
      }),
      Option.getOrUndefined(home),
    ),
).pipe(
  Command.withDescription("Select the Registry used by registry shorthand."),
  Command.withExamples([{ command: "skit registry default public" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.registryRemote],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);
