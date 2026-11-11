import { defineCommand } from "../../commands/definition.js";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { Registry } from "../index.js";
import { CommandMetadata, credentialStoreReadSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../../commands/parameters.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";

export const authStatusCliCommand = defineCommand(
  "status",
  {
    registry: optionalString("registry", "Show one Registry credential."),

    json: jsonFlag,
  },
  ({ registry }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const renderer = yield* Renderer;
      const value = yield* Registry.status(selectedHome, registry);
      yield* renderer.result(result("authStatus", value));
    }),
).pipe(
  Command.withDescription("Show stored Registry credential metadata."),
  Command.withExamples([{ command: "skit auth status" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "process.execute"],
      subprocesses: credentialStoreReadSubprocesses,
    },
    outputSchemas: [outputContracts.authStatus],
    interactive: false,
  }),
);
