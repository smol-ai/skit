import { Effect } from "effect";
import type { InstallScope } from "@smolai/skit-core/library";
import type { InvocationOption } from "@smolai/skit-core/library/session";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import * as Selection from "@smolai/skit-core/library/enable";
import type { SetEnabledRequest } from "@smolai/skit-core/library/enable";
export { SetEnabledIncomplete, type SetEnabledRequest } from "@smolai/skit-core/library/enable";

/** Test fixtures supply paths as a service; production callers pass their resolved home directly. */
export const openSetEnabledSession = (configuration: Selection.SetEnabledConfiguration) =>
  Effect.flatMap(SkitConfiguration, (paths) =>
    Selection.openSetEnabledSession(paths.skitHome, configuration),
  );
export const planSetEnabled = (
  requests: readonly SetEnabledRequest[],
  configuration: Selection.SetEnabledConfiguration,
) =>
  Effect.flatMap(SkitConfiguration, (paths) =>
    Selection.planSetEnabled(paths.skitHome, requests, configuration),
  );
export const applySetEnabledPlan = (plan: Selection.SetEnabledPlan) =>
  Effect.flatMap(SkitConfiguration, (paths) => Selection.applySetEnabledPlan(paths.skitHome, plan));

import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

interface SetEnabledOptions {
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
export const planLibraryEnabled = (options: SetEnabledOptions) => {
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

export const setLibraryEnabled = Effect.fn("Test.setLibraryEnabled")(function* (
  options: SetEnabledOptions,
) {
  const plan = yield* planLibraryEnabled(options);
  if (options.invocation.dryRun) {
    const value = plan.changes[0];
    if (value === undefined) return yield* Effect.die("Expected one plan");
    return { kind: "plan" as const, value };
  }
  const [outcome] = yield* applySetEnabledPlan(plan);
  if (outcome === undefined) return yield* Effect.die("Expected one outcome");
  return outcome;
});
