import {
  LibraryStore,
  projectBindingEffect,
  retireUnboundGlobalProjectionsEffect,
  withLibraryWriter,
  type Binding,
  type DeviceBinding,
  type RepositoryBinding,
  type Digest,
  type ProjectionId,
  type ProjectionTarget,
  type OwnershipMarker,
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
  readonly desiredGlobalBindings?: readonly Binding[];
  readonly onlyBindings?: readonly (DeviceBinding | RepositoryBinding)[];
  readonly retireOnly?: boolean;
  readonly acceptedObservations?: ReadonlyMap<
    ProjectionId,
    { readonly observedHash: Digest; readonly marker: OwnershipMarker }
  >;
  readonly adoption?: { readonly path: string; readonly observedHash: Digest };
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
  const retired = yield* retireUnboundGlobalProjectionsEffect({
    variantsPath: options.variantsPath,
    activeTargets,
    ...(options.desiredGlobalBindings === undefined
      ? {}
      : { desiredBindings: options.desiredGlobalBindings }),
    inactiveOnly: options.onlyBindings !== undefined && options.desiredGlobalBindings === undefined,
  });
  if (options.retireOnly) return { projected: 0, retired, outcomes: [] };

  const state = yield* (yield* LibraryStore).load;
  let projected = 0;
  const bindings = options.includeRepositoryBindings
    ? [...state.global_bindings, ...state.local_bindings]
    : (options.onlyBindings ?? [...state.global_bindings, ...state.local_bindings]);
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
        ...(options.acceptedObservations === undefined
          ? {}
          : { acceptedObservations: options.acceptedObservations }),
        ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
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
