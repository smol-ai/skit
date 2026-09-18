import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { authStatusCommand } from "../../registry/auth.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import {
  homeFlag,
  homePath,
  jsonFlag,
  optionalString,
  optionValue,
} from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

export const authStatusCliCommand = Command.make(
  "status",
  {
    registry: optionalString("registry", "Show one Registry credential."),
    home: homeFlag,
    json: jsonFlag,
  },
  ({ registry, home }) => {
    const selectedHome = homePath(home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* authStatusCommand(selectedHome, optionValue(registry));
        yield* renderer.result(result("authStatus", outputContracts.authStatus, value));
      }),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription("Show stored Registry credential metadata."),
  Command.withExamples([{ command: "skit auth status" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.authStatus],
    exitCodes: [0, 12],
    interactive: false,
  }),
);
