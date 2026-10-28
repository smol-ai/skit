import { SkitConfiguration, skitConfigurationLayer } from "../configuration/skit-configuration.js";
import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { handlePlatformCommand } from "../application.js";
import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  credentialStoreSubprocesses,
} from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../commands/parameters.js";
import {
  addRegistryRemote,
  defaultRegistryRemote,
  listRegistryRemotes,
  removeRegistryRemote,
} from "../registry/auth.js";
import { Renderer } from "../presentation/renderer.js";
import { result } from "./contracts.js";

const name = Argument.String("name");
const origin = Argument.String("origin");

export const registryAddCliCommand = Command.make(
  "add",
  { name, origin, home: homeFlag, json: jsonFlag },
  ({ name, origin, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handlePlatformCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* addRegistryRemote(name, origin, selectedHome);
          yield* renderer.result(result("registryRemote", { ...value, action: "added" }));
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Name a Registry for use in source references."),
  Command.withExamples([{ command: "skit registry add public https://registry.example.com" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.registryRemote],
    exitCodes: [0, 12, 64],
    interactive: false,
  }),
);

export const registryListCliCommand = Command.make(
  "list",
  { home: homeFlag, json: jsonFlag },
  ({ home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handlePlatformCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const registries = yield* listRegistryRemotes(selectedHome);
          yield* renderer.result(result("registryList", { registries }));
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("List named Registries."),
  Command.withExamples([{ command: "skit registry list" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "process.execute"],
      subprocesses: credentialStoreReadSubprocesses,
    },
    outputSchemas: [outputContracts.registryList],
    exitCodes: [0, 12, 64],
    interactive: false,
  }),
);

export const registryDefaultCliCommand = Command.make(
  "default",
  { name, home: homeFlag, json: jsonFlag },
  ({ name, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handlePlatformCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* defaultRegistryRemote(name, selectedHome);
          yield* renderer.result(
            result("registryRemote", {
              ...value,
              action: "defaulted",
            }),
          );
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Select the Registry used by registry shorthand."),
  Command.withExamples([{ command: "skit registry default public" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.registryRemote],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);

export const registryRemoveCliCommand = Command.make(
  "remove",
  { name, home: homeFlag, json: jsonFlag },
  ({ name, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handlePlatformCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* removeRegistryRemote(name, selectedHome);
          yield* renderer.result(
            result("registryRemote", {
              ...value,
              action: "removed",
            }),
          );
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Remove a Registry name."),
  Command.withExamples([{ command: "skit registry remove work" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: credentialStoreSubprocesses,
    },
    outputSchemas: [outputContracts.registryRemote],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);
