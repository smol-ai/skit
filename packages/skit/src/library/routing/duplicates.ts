import { resolve } from "node:path";
import { Effect } from "effect";
import { HarnessName } from "../../harnesses/contracts.js";
import { type InstallScope } from "../scope.js";
import { findDuplicates as findDuplicatesIn, type DuplicateScanError } from "../duplicates.js";
import { harnessDrivers } from "../../harnesses/drivers.js";
import { resolveSkillsDirectory } from "../../harnesses/catalog.js";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "./roots.js";

export {
  DuplicateCopy,
  DuplicateScanError,
  SkillAlias,
  isEntryLink,
  scanSkillsDirectory,
} from "../duplicates.js";

/** Each Harness's readable skills directories for a scope; a global override stands in for its own. */
export function readableSkillsDirectories(
  options: InventoryRootOptions,
  scope: InstallScope,
  harnesses: readonly HarnessName[] = HarnessName.literals,
) {
  return harnesses.flatMap((harness) => {
    const driver = harnessDrivers[harness];
    const own = driver.profile.roots
      .filter(
        (root) => root.readable && root.scope === (scope.kind === "global" ? "global" : "project"),
      )
      .map((root) =>
        resolveSkillsDirectory(root, {
          home: options.home,
          configHome: options.configHome,
          ...(scope.kind === "repository" ? { repository: scope.root } : {}),
        }),
      );
    const override = scope.kind === "global" ? options.overrides[harness] : undefined;
    const roots =
      override === undefined
        ? own
        : driver.rootOverride === "extends"
          ? [...own, ...override]
          : override;
    return roots.map((root) => ({ harness, root: resolve(root) }));
  });
}

/** Other copies of `names` this machine's agents read in `scope`, routed by its configuration. */
export const findDuplicates = Effect.fn("Install.findDuplicatesConfigured")(function* (
  options: InventoryRootOptions,
  scope: InstallScope,
  names: readonly string[],
  errors?: DuplicateScanError[],
) {
  const destinations = (yield* activeInstallDestinations(options)).map((destination) => ({
    destination,
    root: skillsDirectoryFor(destination, scope, options),
  }));
  return yield* findDuplicatesIn(
    { destinations, readable: readableSkillsDirectories(options, scope) },
    names,
    errors,
  );
});
