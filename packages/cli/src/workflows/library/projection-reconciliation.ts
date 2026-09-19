import {
  LibraryStore,
  projectPortableBindingEffect,
  retirePortableUnboundGlobalProjectionsEffect,
  withLibraryWriter,
  type PortableBinding,
  type PortableDeviceBinding,
  type PortableRepositoryBinding,
  type Digest,
  type ProjectionId,
  type OwnershipMarker,
} from "@smolai/skit-core";
import { Effect } from "effect";
import { bindingRoot } from "../../projection/roots.js";
import type { InventoryRootOptions } from "../../projection/roots.js";

export interface LibraryProjectionReconciliationOptions {
  readonly roots?: InventoryRootOptions;
  readonly rootFor?: (
    harness: PortableDeviceBinding["harness"],
    scope: PortableDeviceBinding["scope"] | PortableRepositoryBinding["scope"],
  ) => string | undefined;
  readonly variantsPath: string;
  readonly desiredGlobalBindings?: readonly PortableBinding[];
  readonly onlyBindings?: readonly (PortableDeviceBinding | PortableRepositoryBinding)[];
  readonly retireOnly?: boolean;
  readonly acceptedObservations?: ReadonlyMap<
    ProjectionId,
    { readonly observedHash: Digest; readonly marker: OwnershipMarker }
  >;
  readonly adoptionObservedHash?: Digest;
}

const reconcileWithinWrite = Effect.fnUntraced(function* (
  options: LibraryProjectionReconciliationOptions,
) {
  const retired =
    options.onlyBindings === undefined || options.desiredGlobalBindings !== undefined
      ? yield* retirePortableUnboundGlobalProjectionsEffect({
          variantsPath: options.variantsPath,
          ...(options.desiredGlobalBindings === undefined
            ? {}
            : { desiredBindings: options.desiredGlobalBindings }),
        })
      : 0;
  if (options.retireOnly) return { projected: 0, deferred: 0, retired, outcomes: [] };

  const state = yield* (yield* LibraryStore).load;
  let projected = 0;
  let deferred = 0;
  const bindings = options.onlyBindings ?? [...state.global_bindings, ...state.local_bindings];
  const outcomes: Array<{
    harness: (typeof bindings)[number]["harness"];
    status: "projected" | "deferred";
  }> = [];
  for (const binding of bindings) {
    const root =
      options.rootFor?.(binding.harness, binding.scope) ??
      (options.roots === undefined
        ? undefined
        : bindingRoot(binding.harness, binding.scope, options.roots));
    if (root === undefined) {
      deferred++;
      outcomes.push({ harness: binding.harness, status: "deferred" });
      continue;
    }
    yield* projectPortableBindingEffect({
      harness: binding.harness,
      scope: binding.scope,
      root,
      variantsPath: options.variantsPath,
      ...(options.acceptedObservations === undefined
        ? {}
        : { acceptedObservations: options.acceptedObservations }),
      ...(options.adoptionObservedHash === undefined
        ? {}
        : { adoptionObservedHash: options.adoptionObservedHash }),
    });
    projected++;
    outcomes.push({ harness: binding.harness, status: "projected" });
  }
  return { projected, deferred, retired, outcomes };
});

/** Converge all available Projection targets with current Binding intent under write authority. */
export const reconcileLibraryProjections = Effect.fn("LibraryProjections.reconcile")(function* (
  options: LibraryProjectionReconciliationOptions,
) {
  return yield* withLibraryWriter(reconcileWithinWrite(options));
});
