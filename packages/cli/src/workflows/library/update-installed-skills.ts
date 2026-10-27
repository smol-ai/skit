import {
  LibraryStore,
  deviceInstallationIntent,
  installEnabledSkills,
  leftoverSkills,
  uninstallSkills,
  withLibraryWriter,
  type DeviceBinding,
  type RepositoryBinding,
  type InstallDestination,
  type ManageApproval,
  type SkillId,
} from "@smolai/skit-core";
import { Effect } from "effect";
import {
  activeInstallDestinationsEffect,
  bindingRoot,
  existingRepositorySkillsDirectory,
} from "../../projection/roots.js";
import type { InventoryRootOptions } from "../../projection/roots.js";

export interface UpdateInstalledSkillsOptions {
  readonly roots?: InventoryRootOptions;
  /** A target's global root, or undefined when it is inactive; overrides `roots` for routing. */
  readonly rootFor?: (target: InstallDestination) => string | undefined;
  readonly variantsPath: string;
  readonly onlyBindings?: readonly (DeviceBinding | RepositoryBinding)[];
  readonly manage?: ManageApproval;
  /** Manage unmanaged copies that already hold exactly the bytes SKIT would install. */
  readonly manageIdentical?: boolean;
  readonly restoreNativeDeletedSkills?: readonly string[];
  /** Sync also repairs repository copies at their existing device-local roots. */
  readonly includeRepositoryBindings?: boolean;
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
        ? yield* activeInstallDestinationsEffect(options.roots)
        : targets;
  // Copies at a former or inactive destination are never wanted, whichever settings changed.
  const state = yield* (yield* LibraryStore).load;
  const intent = deviceInstallationIntent(state);
  const retired = yield* uninstallSkills(
    leftoverSkills(state, {
      activeDestinations: activeTargets,
      enabled: intent.bindings,
      inactiveOnly: options.onlyBindings !== undefined,
      ...(options.onlySkillIds === undefined ? {} : { onlySkillIds: options.onlySkillIds }),
    }),
    { variantsPath: options.variantsPath, activeDestinations: activeTargets },
  );

  let projected = 0;
  const bindings = options.includeRepositoryBindings
    ? intent.allBindings
    : (options.onlyBindings ?? intent.allBindings);
  const outcomes: Array<{ target: InstallDestination; scope: (typeof bindings)[number]["scope"] }> =
    [];
  for (const binding of bindings) {
    const repositoryBinding =
      binding.scope.kind === "repository" ? { ...binding, scope: binding.scope } : undefined;
    for (const target of activeTargets) {
      const root =
        binding.scope.kind === "global" && options.rootFor !== undefined
          ? options.rootFor(target)
          : options.roots === undefined
            ? options.includeRepositoryBindings && repositoryBinding !== undefined
              ? existingRepositorySkillsDirectory(state, repositoryBinding, target)
              : undefined
            : bindingRoot(target, binding.scope, options.roots);
      if (root === undefined) continue;
      projected += yield* installEnabledSkills({
        target,
        scope: binding.scope,
        root,
        variantsPath: options.variantsPath,
        restoreNativeDeletedSkills: options.restoreNativeDeletedSkills,
        onlySkillIds: options.onlySkillIds,
        ...(options.manage === undefined ? {} : { manage: options.manage }),
        ...(options.manageIdentical ? { manageIdentical: true } : {}),
      });
      outcomes.push({ target, scope: binding.scope });
    }
  }
  return { projected, retired, outcomes };
}, withLibraryWriter);
