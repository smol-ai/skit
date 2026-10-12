import { configurationForHome } from "../configuration/skit-configuration.js";
import { Effect, Option } from "effect";
import { libraryInstallationConfiguration } from "../library/installation-configuration.js";
import { detectInstalledHarnessesEffect } from "../harness/catalog.js";
import { inventoryRootOptions } from "./parameters.js";

export interface LocalCommandInput {
  readonly home: Option.Option<string>;
  readonly codexRoot: Option.Option<string>;
  readonly claudeRoot: Option.Option<string>;
  readonly opencodeRoot: Option.Option<string>;
  readonly devinRoot: readonly string[];
}

/** Resolve local paths and Harness capabilities shared by Library command workflows. */
export const libraryCommandConfiguration = Effect.fn("CLI.libraryConfiguration")(function* (
  input: LocalCommandInput,
) {
  const paths = yield* configurationForHome(Option.getOrUndefined(input.home));
  const libraryHome = paths.skitHome;
  const inventory = inventoryRootOptions(input, paths);
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
    detectedHarnesses: Effect.succeed(detectedHarnesses),
    acquisition: {
      installation,
      originalsPath: paths.originalsPath,
    },
    pull: {
      installation,
      originalsPath: paths.originalsPath,
      bindings: {
        ...inventory,
        statePath: paths.libraryStatePath,
        variantsPath: paths.variantsPath,
      },
    },
  };
});
