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
  Argument.withDescription("Name of the Registry to remove from this device."),
);

export const registryRemoveCliCommand = defineCommand(
  "remove",
  { name, json: jsonFlag },
  ({ name }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const renderer = yield* Renderer;
      const value = yield* Registry.remotes.remove(name, selectedHome);
      yield* renderer.result(
        result("registryRemote", {
          ...value,
          action: "removed",
        }),
      );
    }),
).pipe(
  Command.withDescription("Remove a Registry name."),
  Command.withExamples([{ command: "skit registry remove work" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.registryRemote],
    interactive: false,
  }),
);
