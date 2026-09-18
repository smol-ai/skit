import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { resolve } from "node:path";
import { handleCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, homePath, jsonFlag } from "../commands/parameters.js";
import { Renderer } from "../presentation/renderer.js";
import {
  readSetupMachineConfig,
  setupRepositoryDecisions,
  updateSetupRepositoryDecision,
} from "../workflows/library/setup.js";
import { result } from "./contracts.js";

const path = Argument.string("path");
const flags = { home: homeFlag, json: jsonFlag };

const mutate = (name: "watch" | "ignore" | "forget") =>
  Command.make(name, { path, ...flags }, (input) => {
    const selectedHome = homePath(input.home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const repository = resolve(input.path);
        const config = yield* updateSetupRepositoryDecision(
          selectedHome,
          repository,
          name === "watch" ? "watched" : name === "ignore" ? "ignored" : undefined,
        );
        yield* renderer.result(
          result("repositoryPolicy", outputContracts.repositoryPolicy, {
            action: name,
            path: repository,
            repositories: config.repositories,
          }),
        );
      }),
      selectedHome,
    );
  }).pipe(
    Command.withDescription(
      name === "watch"
        ? "Include a repository in ordinary Skill inventory."
        : name === "ignore"
          ? "Exclude a repository from ordinary Skill inventory."
          : "Clear this machine's repository decision.",
    ),
    Command.annotate(CommandMetadata, {
      effects: { capabilities: ["filesystem.read", "filesystem.write"] },
      outputSchemas: [outputContracts.repositoryPolicy],
      exitCodes: [0, 64],
      interactive: false,
    }),
  );

export const repositoryListCliCommand = Command.make("list", flags, (input) => {
  const selectedHome = homePath(input.home);
  return handleCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const config = yield* readSetupMachineConfig(selectedHome);
      yield* renderer.result(
        result("repositoryPolicy", outputContracts.repositoryPolicy, {
          action: "list",
          path: "",
          repositories: [...setupRepositoryDecisions(config)],
        }),
      );
    }),
    selectedHome,
  );
}).pipe(
  Command.withDescription("List repository decisions stored for this machine."),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [outputContracts.repositoryPolicy],
    exitCodes: [0],
    interactive: false,
  }),
);

export const repositoryWatchCliCommand = mutate("watch");
export const repositoryIgnoreCliCommand = mutate("ignore");
export const repositoryForgetCliCommand = mutate("forget");
