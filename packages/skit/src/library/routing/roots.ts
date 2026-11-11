import { resolve } from "node:path";
import { Effect, Record } from "effect";
import { HarnessName, type SkillsDirectoryOverrides } from "../../harnesses/contracts.js";
import { type InstallDestination } from "../../installed-skills/destination.js";
import { type InstallScope } from "../scope.js";
import { harnessDrivers } from "../../harnesses/drivers.js";
import { installSkillsDirectory, resolveSkillsDirectory } from "../../harnesses/catalog.js";
import { installDestinationProfiles } from "../../harnesses/install-destinations.js";
import { deduplicateInventoryRoots, type InventoryScanRoot } from "../inventory/roots.js";
import { pathIsWithin } from "../../platform/path-identity.js";

import { type LibraryState } from "../library-state.js";
import { detectInstalledHarnesses } from "../../harnesses/discovery.js";
export interface InventoryRootOptions {
  readonly home: string;
  readonly configHome: string;
  /** Codex's override is the shared `.agents/skills` root, which Codex reads natively. */
  readonly overrides: SkillsDirectoryOverrides;
}

/** Reuse a repository's own route, excluding routes owned by a nested repository. */
export function existingRepositorySkillsDirectory(
  state: LibraryState,
  root: string,
  target: InstallDestination,
): string | undefined {
  return state.installed_skills.find(
    (installedSkill) =>
      installedSkill.destination === target &&
      pathIsWithin(root, installedSkill.root) &&
      !state.repositories.some(
        (other) =>
          other.root !== root &&
          pathIsWithin(root, other.root) &&
          pathIsWithin(other.root, installedSkill.root),
      ),
  )?.root;
}

/** Resolve one target's writable physical skills directory for a Scope. */
export function skillsDirectoryFor(
  target: InstallDestination,
  scope: InstallScope,
  options: InventoryRootOptions,
): string {
  const override = options.overrides[installDestinationProfiles[target]]?.[0];
  if (scope.kind === "global" && override !== undefined) return resolve(override);
  return resolve(
    installSkillsDirectory(
      installDestinationProfiles[target],
      scope.kind === "global"
        ? { scope: "global", home: options.home, configHome: options.configHome }
        : { scope: "project", repository: scope.root },
    ),
  );
}

/** This device's roots: its home and config home, plus any skills directories named on the command line. */
export const inventoryRootOptions = (
  paths: { readonly userHome: string; readonly configHome: string },
  overrides: SkillsDirectoryOverrides = {},
): InventoryRootOptions => ({ home: paths.userHome, configHome: paths.configHome, overrides });

/** The targets this device materializes into: `.agents` always, `.claude` only with Claude Code. */
export const activeInstallDestinations = Effect.fn("Install.activeInstallDestinations")(function* (
  options: InventoryRootOptions,
) {
  const detected = yield* detectInstalledHarnesses({
    home: options.home,
    configHome: options.configHome,
    overrides: options.overrides,
  });
  return installDestinationsFor(detected);
});

const installDestinationsFor = (detected: readonly HarnessName[]): readonly InstallDestination[] =>
  detected.includes("claude-code") ? ["agents", "claude"] : ["agents"];

/** Every Harness's own global roots, plus the skills directories of each repository. */
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
              ...Object.values(driver.profile.roots)
                .filter((root) => root.scope === "global")
                .filter((root) => root.readable)
                .map((root) => resolveSkillsDirectory({ ...root, ...context })),
              ...overrides,
            ]
          : overrides.length > 0
            ? overrides
            : [installSkillsDirectory(harness, { scope: "global", ...context })];
      return roots.map((root) => ({ harness, root: resolve(root) }));
    }),
    ...state.repositories.flatMap((repository) =>
      Record.toEntries(installDestinationProfiles).map(([target, harness]) => ({
        harness,
        root: skillsDirectoryFor(target, { kind: "repository", root: repository.root }, options),
      })),
    ),
  ]);
}
