import { defineCommand } from "../../commands/definition.js";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { CommandMetadata, credentialStoreSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag } from "../../commands/parameters.js";
import { Registry } from "../index.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";

const name = Argument.String("name").pipe(
  Argument.withDescription("Name of the Registry to use by default."),
);

export const registryDefaultCliCommand = defineCommand(
  "default",
  { name, json: jsonFlag },
  ({ name }) =>
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
).pipe(
  Command.withDescription("Select the Registry used by registry shorthand."),
  Command.withExamples([{ command: "skit registry default public" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.registryRemote],
    interactive: false,
  }),
);
