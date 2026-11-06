import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { handlePlatformCommand } from "../../application.js";
import { Registry } from "../index.js";
import { CommandMetadata, credentialStoreReadSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag, optionalString, optionValue } from "../../commands/parameters.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";

export const authStatusCliCommand = Command.make(
  "status",
  {
    registry: optionalString("registry", "Show one Registry credential."),
    home: homeFlag,
    json: jsonFlag,
  },
  ({ registry, home }) =>
    handlePlatformCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;

        const selectedHome = paths.skitHome;
        const renderer = yield* Renderer;
        const value = yield* Registry.status(selectedHome, optionValue(registry));
        yield* renderer.result(result("authStatus", value));
      }),
      { home },
    ),
).pipe(
  Command.withDescription("Show stored Registry credential metadata."),
  Command.withExamples([{ command: "skit auth status" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "process.execute"],
      subprocesses: credentialStoreReadSubprocesses,
    },
    outputSchemas: [outputContracts.authStatus],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);
