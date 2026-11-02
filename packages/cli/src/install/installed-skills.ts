import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import { Digest } from "effect/crypto";
import {
  InstalledSkills,
  InstalledSkillsNode,
  LinkStat,
  SourceProcess,
  TreeHasher,
  type InstallScope,
  type TreeRequirements,
} from "@smolai/skit-core";
import { SkitConfiguration } from "../configuration/skit-configuration.js";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "./roots.js";
import { findDuplicates, readableSkillsDirectories } from "./duplicates.js";

/**
 * This device's skill folders, routed by this machine's configuration. Without it, install
 * destinations are unknown rather than inactive: anything that needs them fails.
 */
export const make = Effect.fn("InstalledSkills.make")(function* (
  configuration?: InventoryRootOptions,
) {
  if (configuration === undefined) return yield* InstalledSkillsNode.make();
  const routing = {
    home: configuration.home,
    configHome: configuration.configHome,
    overrides: structuredClone(configuration.overrides),
  };
  const context = (yield* Effect.context<
    TreeRequirements | TreeHasher | Digest.Digest | SkitConfiguration
  >()).pipe(
    Context.pick(
      FileSystem.FileSystem,
      Path.Path,
      LinkStat,
      SourceProcess,
      TreeHasher,
      Digest.Digest,
      SkitConfiguration,
    ),
  );
  const failed = (cause: InstalledSkills.Cause) =>
    new InstalledSkills.Failed({ path: routing.home, cause, displaced: Option.none() });
  return yield* InstalledSkillsNode.make({
    active: activeInstallDestinations(routing).pipe(
      Effect.provide(context),
      Effect.mapError(failed),
    ),
    destinations: Effect.fn("InstalledSkills.destinations")(function* (scope: InstallScope) {
      return (yield* activeInstallDestinations(routing).pipe(
        Effect.provide(context),
        Effect.mapError(failed),
      )).map((destination) => ({
        destination,
        root: skillsDirectoryFor(destination, scope, routing),
      }));
    }),
    duplicates: {
      scan: Effect.fn("InstalledSkills.duplicates")(function* (scope, names) {
        const warnings: InstalledSkills.Warning[] = [];
        const copies = names.length
          ? yield* findDuplicates(routing, scope, names, warnings).pipe(
              Effect.provide(context),
              Effect.mapError(failed),
            )
          : [];
        return {
          copies,
          warnings,
          roots: readableSkillsDirectories(routing, scope).map((root) => root.root),
        };
      }),
    },
  });
});
export const layer = (configuration?: InventoryRootOptions) =>
  Layer.effect(InstalledSkills.Service, make(configuration));
