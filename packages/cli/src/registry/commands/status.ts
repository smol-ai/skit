import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { handlePlatformCommand } from "../../commands/handler.js";
import { authStatusCommand } from "../auth.js";
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
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handlePlatformCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* authStatusCommand(selectedHome, optionValue(registry));
          yield* renderer.result(result("authStatus", value));
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
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
