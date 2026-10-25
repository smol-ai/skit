import {
  LibraryStore,
  deviceInstallationIntent,
  projectBindingEffect,
  retireUnboundGlobalProjectionsEffect,
  withLibraryWriter,
  type DeviceBinding,
  type RepositoryBinding,
  type ProjectionTarget,
  type ProjectionAdoption,
} from "@smolai/skit-core";
import { Effect } from "effect";
import {
  activeProjectionTargetsEffect,
  bindingRoot,
  existingRepositoryProjectionRoot,
} from "../../projection/roots.js";
import type { InventoryRootOptions } from "../../projection/roots.js";

export interface LibraryProjectionReconciliationOptions {
  readonly roots?: InventoryRootOptions;
  /** A target's global root, or undefined when it is inactive; overrides `roots` for routing. */
  readonly rootFor?: (target: ProjectionTarget) => string | undefined;
  readonly variantsPath: string;
  readonly onlyBindings?: readonly (DeviceBinding | RepositoryBinding)[];
  readonly adoption?: ProjectionAdoption;
  /** Adopt unmanaged copies that already hold exactly the projected bytes. */
  readonly adoptIdentical?: boolean;
  readonly restoreNativeDeletedSkills?: readonly string[];
  /** Sync also repairs repository copies at their existing device-local roots. */
  readonly includeRepositoryBindings?: boolean;
}

const targets = ["agents", "claude"] as const satisfies readonly ProjectionTarget[];

const reconcileWithinWrite = Effect.fnUntraced(function* (
  options: LibraryProjectionReconciliationOptions,
) {
  // Without routing this device's targets are unknown, not inactive: retire nothing for that.
  const activeTargets =
    options.rootFor !== undefined
      ? targets.filter((target) => options.rootFor!(target) !== undefined)
      : options.roots !== undefined
        ? yield* activeProjectionTargetsEffect(options.roots)
        : targets;
  // Copies at a former or inactive target are never wanted, whichever Bindings changed.
  const state = yield* (yield* LibraryStore).load;
  const intent = deviceInstallationIntent(state);
  const retired = yield* retireUnboundGlobalProjectionsEffect({
    variantsPath: options.variantsPath,
    activeTargets,
    desiredBindings: intent.bindings,
    inactiveOnly: options.onlyBindings !== undefined,
  });

  let projected = 0;
  const bindings = options.includeRepositoryBindings
    ? intent.allBindings
    : (options.onlyBindings ?? intent.allBindings);
  const outcomes: Array<{ target: ProjectionTarget; scope: (typeof bindings)[number]["scope"] }> =
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
              ? existingRepositoryProjectionRoot(state, repositoryBinding, target)
              : undefined
            : bindingRoot(target, binding.scope, options.roots);
      if (root === undefined) continue;
      projected += yield* projectBindingEffect({
        target,
        scope: binding.scope,
        root,
        variantsPath: options.variantsPath,
        restoreNativeDeletedSkills: options.restoreNativeDeletedSkills,
        ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
        ...(options.adoptIdentical ? { adoptIdentical: true } : {}),
      });
      outcomes.push({ target, scope: binding.scope });
    }
  }
  return { projected, retired, outcomes };
});

/** Converge every active Projection target with current Binding intent under write authority. */
export const reconcileLibraryProjections = Effect.fn("LibraryProjections.reconcile")(function* (
  options: LibraryProjectionReconciliationOptions,
) {
  return yield* withLibraryWriter(reconcileWithinWrite(options));
});
