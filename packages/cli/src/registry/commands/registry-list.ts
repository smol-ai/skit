import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { handlePlatformCommand } from "../../commands/handler.js";
import { CommandMetadata, credentialStoreReadSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../../commands/parameters.js";
import { Registry } from "../index.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";

export const registryListCliCommand = Command.make(
  "list",
  { home: homeFlag, json: jsonFlag },
  ({ home }) =>
    handlePlatformCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;

        const selectedHome = paths.skitHome;
        const renderer = yield* Renderer;
        const registries = yield* Registry.remotes.list(selectedHome);
        yield* renderer.result(result("registryList", { registries }));
      }),
      Option.getOrUndefined(home),
    ),
).pipe(
  Command.withDescription("List named Registries."),
  Command.withExamples([{ command: "skit registry list" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "process.execute"],
      subprocesses: credentialStoreReadSubprocesses,
    },
    outputSchemas: [outputContracts.registryList],
    exitCodes: [0, 12, 64],
    interactive: false,
  }),
);
