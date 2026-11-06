import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { handleRegistryCommand } from "../../application.js";
import { CommandMetadata, credentialStoreSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";
import { authLogoutCommand } from "./logout.js";

const origin = Argument.String("origin").pipe(Argument.optional);

export const authLogoutCliCommand = Command.make(
  "logout",
  { origin, home: homeFlag, json: jsonFlag },
  ({ origin, home }) =>
    handleRegistryCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;

        const selectedHome = paths.skitHome;
        const renderer = yield* Renderer;
        const value = yield* authLogoutCommand(selectedHome, Option.getOrUndefined(origin));
        yield* renderer.result(result("authLogout", value));
      }),
      { home },
    ),
).pipe(
  Command.withDescription("Revoke and remove a stored CLI credential."),
  Command.withExamples([
    { command: "skit auth logout" },
    { command: "skit auth logout https://skit.example.com" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "network.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.authLogout],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);
