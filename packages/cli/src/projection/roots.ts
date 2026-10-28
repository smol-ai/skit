import { resolve } from "node:path";
import { Effect, Record } from "effect";
import {
  HarnessName,
  harnessDrivers,
  installSkillsDirectory,
  installDestinationProfiles,
  installDestinationDirectory,
  resolveSkillsDirectory,
  deduplicateInventoryRoots,
  pathIsWithin,
  type SkillsDirectoryOverrides,
  type InstallDestination,
  type SkitBindingScope,
  type LibraryState,
  type InventoryScanRoot,
  type RepositoryBinding,
} from "@smolai/skit-core";
import { detectInstalledHarnesses } from "../harness/catalog.js";
export interface InventoryRootOptions {
  readonly home: string;
  readonly configHome: string;
  /** Codex's override is the shared `.agents/skills` root, which Codex reads natively. */
  readonly overrides: SkillsDirectoryOverrides;
}

/** Reuse a repository's own route, excluding routes owned by a nested repository Binding. */
export function existingRepositorySkillsDirectory(
  state: LibraryState,
  binding: RepositoryBinding,
  target: InstallDestination,
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

/** Resolve one target's writable physical skills directory for a Scope. */
export function bindingRoot(
  target: InstallDestination,
  scope: SkitBindingScope,
  options: InventoryRootOptions,
): string {
  const override = options.overrides[installDestinationProfiles[target]]?.[0];
  if (scope.kind === "global" && override !== undefined) return resolve(override);
  return resolve(
    installDestinationDirectory(target, scope.kind === "global" ? "global" : "project", {
      home: options.home,
      configHome: options.configHome,
      ...(scope.kind === "repository" ? { repository: scope.root } : {}),
    }),
  );
}

/** The targets this device materializes into: `.agents` always, `.claude` only with Claude Code. */
export const activeInstallDestinations = Effect.fn("Projection.activeInstallDestinations")(
  function* (options: InventoryRootOptions) {
    const detected = yield* detectInstalledHarnesses({
      home: options.home,
      configHome: options.configHome,
      overrides: options.overrides,
    });
    return installDestinationsFor(detected);
  },
);

export const installDestinationsFor = (
  detected: readonly HarnessName[],
): readonly InstallDestination[] =>
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
                .map((root) => resolveSkillsDirectory(root, context)),
              ...overrides,
            ]
          : overrides.length > 0
            ? overrides
            : [installSkillsDirectory(harness, "global", context)];
      return roots.flatMap((root) => (root === null ? [] : [{ harness, root: resolve(root) }]));
    }),
    ...state.local_bindings.flatMap((binding) =>
      Record.toEntries(installDestinationProfiles).map(([target, harness]) => ({
        harness,
        root: bindingRoot(target, binding.scope, options),
      })),
    ),
  ]);
}
