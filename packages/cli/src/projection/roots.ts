import { resolve } from "node:path";
import { Effect, Record } from "effect";
import {
  HarnessName,
  harnessDrivers,
  projectionRoot,
  projectionTargetProfiles,
  projectionTargetRoot,
  resolveHarnessRoot,
  deduplicateInventoryRoots,
  pathIsWithin,
  type HarnessRootOverrides,
  type ProjectionTarget,
  type SkitBindingScope,
  type LibraryState,
  type InventoryScanRoot,
  type RepositoryBinding,
} from "@smolai/skit-core";
import { detectInstalledHarnessesEffect } from "../harness/catalog.js";
export interface InventoryRootOptions {
  readonly home: string;
  readonly configHome: string;
  /** Codex's override is the shared `.agents/skills` root, which Codex reads natively. */
  readonly overrides: HarnessRootOverrides;
}

/** Reuse a repository's own route, excluding routes owned by a nested repository Binding. */
export function existingRepositoryProjectionRoot(
  state: LibraryState,
  binding: RepositoryBinding,
  target: ProjectionTarget,
): string | undefined {
  return state.projections.find(
    (projection) =>
      projection.target === target &&
      pathIsWithin(binding.scope.root, projection.root) &&
      !state.local_bindings.some(
        (other) =>
          other.scope.root !== binding.scope.root &&
          pathIsWithin(binding.scope.root, other.scope.root) &&
          pathIsWithin(other.scope.root, projection.root),
      ),
  )?.root;
}

/** Resolve one target's writable physical Skill root for a Scope. */
export function bindingRoot(
  target: ProjectionTarget,
  scope: SkitBindingScope,
  options: InventoryRootOptions,
): string {
  const override = options.overrides[projectionTargetProfiles[target]]?.[0];
  if (scope.kind === "global" && override !== undefined) return resolve(override);
  return resolve(
    projectionTargetRoot(target, scope.kind === "global" ? "global" : "project", {
      home: options.home,
      configHome: options.configHome,
      ...(scope.kind === "repository" ? { repository: scope.root } : {}),
    }),
  );
}

/** The targets this device materializes into: `.agents` always, `.claude` only with Claude Code. */
export const activeProjectionTargetsEffect = Effect.fn("Projection.activeTargets")(function* (
  options: InventoryRootOptions,
) {
  const detected = yield* detectInstalledHarnessesEffect({
    home: options.home,
    configHome: options.configHome,
    overrides: options.overrides,
  });
  return activeProjectionTargets(detected);
});

export const activeProjectionTargets = (
  detected: readonly HarnessName[],
): readonly ProjectionTarget[] =>
  detected.includes("claude-code") ? ["agents", "claude"] : ["agents"];

/** Every Harness's own global roots, plus the target roots of each repository Binding. */
export function selectInventoryRoots(
  state: LibraryState,
  options: InventoryRootOptions,
): InventoryScanRoot[] {
  const context = { home: options.home, configHome: options.configHome };
  return deduplicateInventoryRoots([
    ...HarnessName.literals.flatMap((harness) => {
      const driver = harnessDrivers[harness];
      const overrides = options.overrides[harness] ?? [];
      const roots =
        driver.rootOverride === "extends"
          ? [
              ...driver.profile.roots
                .filter((root) => root.scope === "global" && root.readable)
                .map((root) => resolveHarnessRoot(root, context)),
              ...overrides,
            ]
          : overrides.length > 0
            ? overrides
            : [projectionRoot(harness, "global", context)];
      return roots.flatMap((root) => (root === null ? [] : [{ harness, root: resolve(root) }]));
    }),
    ...state.local_bindings.flatMap((binding) =>
      Record.toEntries(projectionTargetProfiles).map(([target, harness]) => ({
        harness,
        root: bindingRoot(target, binding.scope, options),
      })),
    ),
  ]);
}
