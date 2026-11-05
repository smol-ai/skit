import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { handleRegistryCommand } from "../../commands/handler.js";
import { Registry } from "../index.js";
import { CommandMetadata, credentialStoreSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";

export const authLogoutCommand = Effect.fn("CLI.authLogout")(function* (
  home?: string,
  selectedOrigin?: string,
) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Revoking CLI credential",
    Effect.scoped(Registry.logout(home, selectedOrigin)),
  );
});

const origin = Argument.String("origin").pipe(Argument.optional);

export const authLogoutCliCommand = Command.make(
  "logout",
  { origin, home: homeFlag, json: jsonFlag },
  ({ origin, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handleRegistryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* authLogoutCommand(selectedHome, Option.getOrUndefined(origin));
          yield* renderer.result(result("authLogout", value));
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
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
