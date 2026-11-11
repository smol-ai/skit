import { defineCommand } from "../../commands/definition.js";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import { CommandMetadata, credentialStoreSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";
import { authLogoutCommand } from "./logout.js";

const origin = Argument.String("origin").pipe(
  Argument.withDescription(
    "Registry name or origin to sign out of; may be omitted when exactly one stored account exists.",
  ),
  Argument.optional,
);

export const authLogoutCliCommand = defineCommand(
  "logout",
  { origin, json: jsonFlag },
  ({ origin }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const renderer = yield* Renderer;
      const value = yield* authLogoutCommand(selectedHome, Option.getOrUndefined(origin));
      yield* renderer.result(result("authLogout", value));
    }),
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
    interactive: false,
  }),
);
