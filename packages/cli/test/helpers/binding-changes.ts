import { Effect } from "effect";
import type { InstallScope } from "@smolai/skit-core";
import type { InvocationOption } from "../../src/invocation/policy.js";
import {
  planSetEnabled,
  applySetEnabledPlan,
  type SetEnabledRequest,
} from "../../src/library-application/set-enabled.js";
import type { InventoryRootOptions } from "../../src/projection/roots.js";

interface BindingOptions {
  readonly query: string;
  readonly all: boolean;
  readonly selectedSkills?: readonly string[];
  readonly allowDuplicate?: boolean;
  readonly allowedDuplicateSymlinks?: SetEnabledRequest["allowedDuplicateSymlinks"];
  readonly manage?: SetEnabledRequest["manage"];
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
  readonly invocation: {
    readonly scope: InstallScope;
    readonly enabled: boolean;
    readonly invocation?: InvocationOption;
    readonly dryRun: boolean;
  };
}

/** Test convenience for one request; all planning and execution use the public application seam. */
export const previewTestBindings = (options: BindingOptions) => {
  const request: SetEnabledRequest = {
    query: options.query,
    all: options.all,
    selectedSkills: options.selectedSkills,
    allowDuplicate: options.allowDuplicate,
    allowedDuplicateSymlinks: options.allowedDuplicateSymlinks,
    manage: options.manage,
    scope: options.invocation.scope,
    enabled: options.invocation.enabled,
    invocation: options.invocation.invocation,
  };
  return planSetEnabled([request], options.roots);
};

export const setLibraryBindings = Effect.fn("Test.setLibraryBindings")(function* (
  options: BindingOptions,
) {
  const plan = yield* previewTestBindings(options);
  if (options.invocation.dryRun) {
    const value = plan.changes[0];
    if (value === undefined) return yield* Effect.die("Expected one Binding plan");
    return { kind: "plan" as const, value };
  }
  const [outcome] = yield* applySetEnabledPlan(plan);
  if (outcome === undefined) return yield* Effect.die("Expected one Binding outcome");
  return outcome;
});
