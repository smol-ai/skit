import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { resolve } from "node:path";
import { handlePlatformCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import { repositoryOutputContracts } from "../library/repository.js";
import { homeFlag, jsonFlag } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import * as MachineSettings from "@smolai/skit-core/machine-settings";
import { encodeResult as result } from "./encode-result.js";

const path = Argument.String("path");

const flags = { home: homeFlag, json: jsonFlag };

export const makeRepositoryCommand = (name: "watch" | "ignore" | "forget") =>
  Command.make(name, { path, ...flags }, (input) =>
    handlePlatformCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;

        const selectedHome = paths.skitHome;
        const renderer = yield* Renderer;
        const repository = resolve(input.path);
        const { repositories } = yield* MachineSettings.setRepositoryDecision(
          selectedHome,
          repository,
          name === "watch" ? "watched" : name === "ignore" ? "ignored" : undefined,
        );
        yield* renderer.result(
          result("repositoryPolicy", repositoryOutputContracts.repositoryPolicy, {
            action: name,
            path: repository,
            repositories,
          }),
        );
      }),
      Option.getOrUndefined(input.home),
    ),
  ).pipe(
    Command.withDescription(
      name === "watch"
        ? "Include a repository in ordinary Skill inventory."
        : name === "ignore"
          ? "Exclude a repository from ordinary Skill inventory."
          : "Clear this machine's repository decision.",
    ),
    Command.annotate(CommandMetadata, {
      effects: { capabilities: ["filesystem.read", "filesystem.write"] },
      outputSchemas: [repositoryOutputContracts.repositoryPolicy],
      exitCodes: [0, 12, 64],
      interactive: false,
    }),
  );
