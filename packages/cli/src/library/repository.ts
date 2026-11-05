import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { resolve } from "node:path";
import { handlePlatformCommand } from "../commands/handler.js";
import { CommandMetadata } from "../commands/metadata.js";
import { repositoryOutputContracts } from "./repository/output.js";
import { homeFlag, jsonFlag } from "../commands/parameters.js";
import { Renderer } from "../terminal/renderer.js";
import * as MachineSettings from "@smolai/skit-core/machine-settings";
import { encodeResult as result } from "../commands/encode-result.js";

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
            result("repositoryPolicy", repositoryOutputContracts.repositoryPolicy, {
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
      outputSchemas: [repositoryOutputContracts.repositoryPolicy],
      exitCodes: [0, 12, 64],
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
          result("repositoryPolicy", repositoryOutputContracts.repositoryPolicy, {
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
    outputSchemas: [repositoryOutputContracts.repositoryPolicy],
    exitCodes: [0, 64],
    interactive: false,
  }),
);

export const repositoryWatchCliCommand = mutate("watch");
export const repositoryIgnoreCliCommand = mutate("ignore");
export const repositoryForgetCliCommand = mutate("forget");

export { repositoryOutputContracts } from "./repository/output.js";
export { renderRepositoryPolicy } from "./repository/present.js";
