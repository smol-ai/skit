import { SkitConfiguration, skitConfigurationLayer } from "../configuration/skit-configuration.js";
import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { resolve } from "node:path";
import { handlePlatformCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../commands/parameters.js";
import { Renderer } from "../presentation/renderer.js";
import { MachineSettings } from "@smolai/skit-core";
import { result } from "./contracts.js";

const path = Argument.String("path");
const flags = { home: homeFlag, json: jsonFlag };

const mutate = (name: "watch" | "ignore" | "forget") =>
  Command.make(name, { path, ...flags }, (input) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handlePlatformCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const repository = resolve(input.path);
          const config = yield* MachineSettings.setRepositoryDecision(
            selectedHome,
            repository,
            name === "watch" ? "watched" : name === "ignore" ? "ignored" : undefined,
          );
          yield* renderer.result(
            result("repositoryPolicy", {
              action: name,
              path: repository,
              repositories: config.repositories,
            }),
          );
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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
      outputSchemas: [outputContracts.repositoryPolicy],
      exitCodes: [0, 64],
      interactive: false,
    }),
  );

export const repositoryListCliCommand = Command.make("list", flags, (input) =>
  Effect.gen(function* () {
    const paths = yield* SkitConfiguration;

    const selectedHome = paths.skitHome;
    return yield* handlePlatformCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const config = yield* MachineSettings.read(selectedHome);
        yield* renderer.result(
          result("repositoryPolicy", {
            action: "list",
            path: "",
            repositories: [...config.repositories],
          }),
        );
      }),
    );
  }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
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
