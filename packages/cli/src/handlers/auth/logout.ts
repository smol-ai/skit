import { SkitPaths, skitPathsLayer } from "../../configuration/paths.js";
import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { handleRegistryCommand } from "../../application.js";
import { authLogoutCommand } from "../../registry/auth.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

const origin = Argument.String("origin").pipe(Argument.optional);

export const authLogoutCliCommand = Command.make(
  "logout",
  { origin, home: homeFlag, json: jsonFlag },
  ({ origin, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitPaths;

      const selectedHome = paths.skitHome;
      return yield* handleRegistryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* authLogoutCommand(selectedHome, Option.getOrUndefined(origin));
          yield* renderer.result(result("authLogout", outputContracts.authLogout, value));
        }),
      );
    }).pipe(Effect.provide(skitPathsLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Revoke and remove a stored CLI credential."),
  Command.withExamples([
    { command: "skit auth logout" },
    { command: "skit auth logout https://skit.example.com" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["network.write", "filesystem.write"] },
    outputSchemas: [outputContracts.authLogout],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);
