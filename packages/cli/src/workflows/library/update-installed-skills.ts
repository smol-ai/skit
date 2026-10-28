import {
  LibraryStore,
  deviceInstallationIntent,
  installEnabledSkills,
  leftoverSkills,
  uninstallSkills,
  withLibraryWriter,
  type EnabledAtScope,
  type InstallDestination,
  type ManageApproval,
  type SkillId,
} from "@smolai/skit-core";
import { Effect } from "effect";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  existingRepositorySkillsDirectory,
} from "../../install/roots.js";
import type { InventoryRootOptions } from "../../install/roots.js";

export interface UpdateInstalledSkillsOptions {
  readonly roots?: InventoryRootOptions;
  /** A target's global root, or undefined when it is inactive; overrides `roots` for routing. */
  readonly rootFor?: (target: InstallDestination) => string | undefined;
  readonly variantsPath: string;
  readonly onlyScopes?: readonly EnabledAtScope[];
  readonly manage?: ManageApproval;
  /** Manage unmanaged copies that already hold exactly the bytes SKIT would install. */
  readonly manageIdentical?: boolean;
  readonly restoreNativeDeletedSkills?: readonly string[];
  /** Sync also repairs repository copies at their existing device-local roots. */
  readonly includeRepositories?: boolean;
  readonly onlySkillIds?: readonly SkillId[];
}

const targets = ["agents", "claude"] as const satisfies readonly InstallDestination[];

/**
 * Bring every active install destination in line with what is enabled: uninstall the leftover
 * global copies, then install each enabled setting's skills. Holds the Library writer.
 */
export const updateInstalledSkills = Effect.fn("Library.updateInstalledSkills")(function* (
  options: UpdateInstalledSkillsOptions,
) {
  // Without routing this device's destinations are unknown, not inactive: uninstall nothing for that.
  const activeTargets =
    options.rootFor !== undefined
      ? targets.filter((target) => options.rootFor!(target) !== undefined)
      : options.roots !== undefined
        ? yield* activeInstallDestinations(options.roots)
        : targets;
  // Copies at a former or inactive destination are never wanted, whichever settings changed.
  const state = yield* (yield* LibraryStore).load;
  const intent = deviceInstallationIntent(state);
  const uninstalled = yield* uninstallSkills(
    leftoverSkills(state, {
      activeDestinations: activeTargets,
      enabled: intent.globals[0]?.enabled ?? [],
      inactiveOnly: options.onlyScopes !== undefined,
      ...(options.onlySkillIds === undefined ? {} : { onlySkillIds: options.onlySkillIds }),
    }),
    { variantsPath: options.variantsPath, activeDestinations: activeTargets },
  );

  let installed = 0;
  const lists = options.includeRepositories
    ? intent.byScope
    : (options.onlyScopes ?? intent.byScope);
  const outcomes: Array<{ target: InstallDestination; scope: EnabledAtScope["scope"] }> = [];
  for (const { scope } of lists) {
    for (const target of activeTargets) {
      const root =
        scope.kind === "global" && options.rootFor !== undefined
          ? options.rootFor(target)
          : options.roots === undefined
            ? options.includeRepositories && scope.kind === "repository"
              ? existingRepositorySkillsDirectory(state, scope.root, target)
              : undefined
            : skillsDirectoryFor(target, scope, options.roots);
      if (root === undefined) continue;
      installed += yield* installEnabledSkills({
        target,
        scope,
        root,
        variantsPath: options.variantsPath,
        restoreNativeDeletedSkills: options.restoreNativeDeletedSkills,
        onlySkillIds: options.onlySkillIds,
        ...(options.manage === undefined ? {} : { manage: options.manage }),
        ...(options.manageIdentical ? { manageIdentical: true } : {}),
      });
      outcomes.push({ target, scope });
    }
  }
  return { installed, uninstalled, outcomes };
}, withLibraryWriter);
