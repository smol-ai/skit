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
  Argument.withDescription("Local name for this Registry."),
);

const origin = Argument.String("origin").pipe(
  Argument.withDescription("Registry origin URL, including its protocol."),
);

export const registryAddCliCommand = defineCommand(
  "add",
  { name, origin, json: jsonFlag },
  ({ name, origin }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const renderer = yield* Renderer;
      const value = yield* Registry.remotes.add(name, origin, selectedHome);
      yield* renderer.result(result("registryRemote", { ...value, action: "added" }));
    }),
).pipe(
  Command.withDescription("Name a Registry for use in source references."),
  Command.withExamples([{ command: "skit registry add public https://registry.example.com" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.registryRemote],
    interactive: false,
  }),
);
