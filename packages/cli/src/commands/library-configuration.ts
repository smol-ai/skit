import { Effect, Option } from "effect";
import { join } from "node:path";
import { RegistryAuth } from "../registry/auth-service.js";
import { libraryInstallationConfiguration } from "../library/installation-configuration.js";
import { detectInstalledHarnessesEffect } from "../harness/catalog.js";
import { homePath, inventoryRootOptions } from "./parameters.js";

export interface LocalCommandInput {
  readonly home: Option.Option<string>;
  readonly codexRoot: Option.Option<string>;
  readonly claudeRoot: Option.Option<string>;
  readonly opencodeRoot: Option.Option<string>;
  readonly devinRoot: readonly string[];
}

/** Resolve the local paths and Registry credential shared by Library command workflows. */
export const libraryCommandConfiguration = Effect.fn("CLI.libraryConfiguration")(function* (
  input: LocalCommandInput,
  registry?: string,
  command?: string,
) {
  const libraryHome = homePath(input.home);
  const inventory = inventoryRootOptions(input);
  const registryAuth = yield* (yield* RegistryAuth).resolve(registry, command);
  const authState = registryAuth.authState;
  const detectedHarnesses = yield* detectInstalledHarnessesEffect({
    home: inventory.home,
    configHome: inventory.configHome,
    codexRoot: inventory.overrides.codex,
    claudeRoot: inventory.overrides.claude,
    opencodeRoot: inventory.overrides.opencode,
    devinRoots: inventory.overrides.devin,
  });
  const installation = libraryInstallationConfiguration(libraryHome, inventory, detectedHarnesses);
  return {
    libraryHome,
    inventory,
    authState,
    detectedHarnesses: Effect.succeed(detectedHarnesses),
    acquisition: {
      installation,
      originalsPath: join(libraryHome, "originals"),
    },
    pull: {
      installation,
      originalsPath: join(libraryHome, "originals"),
      bindings: {
        ...inventory,
        statePath: join(libraryHome, "state.json"),
        variantsPath: join(libraryHome, "variants"),
      },
    },
  };
});
