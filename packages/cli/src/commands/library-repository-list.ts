import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { handlePlatformCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import { repositoryOutputContracts } from "../library/repository.js";
import { homeFlag, jsonFlag } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import * as MachineSettings from "@smolai/skit-core/machine-settings";
import { encodeResult as result } from "./encode-result.js";

const flags = { home: homeFlag, json: jsonFlag };

export const repositoryListCliCommand = Command.make("list", flags, (input) =>
  handlePlatformCommand(
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const renderer = yield* Renderer;
      const { repositories } = yield* MachineSettings.read(selectedHome);
      yield* renderer.result(
        result("repositoryPolicy", repositoryOutputContracts.repositoryPolicy, {
          action: "list",
          path: "",
          repositories: [...repositories],
        }),
      );
    }),
    Option.getOrUndefined(input.home),
  ),
).pipe(
  Command.withDescription("List repository decisions stored for this machine."),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [repositoryOutputContracts.repositoryPolicy],
    exitCodes: [0, 64],
    interactive: false,
  }),
);
