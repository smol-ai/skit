import { join } from "node:path";
import { withConfigurationWriter } from "../../configuration-writer.js";
import { Data, Effect } from "effect";
import { canonicalJson, Digest, hashParts, libraryStateRevision } from "@smolai/skit-core";
import { isEntryLink, observeHarnessShadows } from "../../projection/harness-shadows.js";
import {
  activeProjectionTargetsEffect,
  bindingRoot,
  type InventoryRootOptions,
} from "../../projection/roots.js";
import type { SetupResult } from "./setup-contract.js";
import { collectBrokenLinks, SetupDiscovery, suggestRepositoryRoots } from "./setup-discovery.js";
import { observeSetupCopies } from "./setup-observation.js";
import { classifySetupOnboarding } from "./setup-onboarding.js";
import { recommendedSetupSelection, setupApplyCommandLine } from "./setup-decisions.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
export { collectHarnessRoots, saveSetupMachineConfig, SetupDiscovery } from "./setup-discovery.js";
export { classifyObservedOwner, isSetupCandidateFromCodex } from "./setup-onboarding.js";
export { classifySetupOnboarding, setupInstanceGroupKey } from "./setup-onboarding.js";
export { setupLockCollection, setupLockGroupKey } from "./skills-sh-lock-source.js";
export { computeSkillsShCompatibleHash as computeSkillsLockCompatibleHash } from "./skills-sh-compatible-hash.js";
export class SetupPlanStale
  extends Data.TaggedError("SetupPlanStale")<{
    approvedPlanId: typeof Digest.Type;
    currentPlanId: typeof Digest.Type;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  // Like every other plan that changed after it was reviewed.
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Run `skit setup` again and review the current plan; `skit setup --json` reports its planId.";
  get message() {
    return "The setup plan changed after it was reviewed. Review the current plan before applying.";
  }
}

export interface SetupOptions {
  readonly libraryHome: string;
  readonly repositoryRoots?: readonly string[];
  readonly inventory: InventoryRootOptions;
  readonly persistRoots: boolean;
  readonly probePath?: string;
  readonly skillsStateHome?: string;
  readonly machineDisplayName?: string;
  readonly repositoryDecisions?: readonly {
    readonly path: string;
    readonly status: "watched" | "ignored";
  }[];
  readonly scanDecidedRepositories?: boolean;
}

/** One full setup scan, and the Library state its plan was made against. */
const observeSetup = Effect.fn("Library.setup")(
  function* (options: SetupOptions) {
    const evidence = yield* (yield* SetupDiscovery).collect(options);
    const {
      machineConfig,
      discoveryRoots,
      existingDecisions,
      discovering,
      walk,
      repositoryConfigs,
      harnessRoots,
      library,
      authoredCollections,
      discoveryComplete,
      locks,
    } = evidence;
    const { instances, onboardingInstances, probes, projections } = yield* observeSetupCopies(
      evidence,
      options.inventory.home,
      options.probePath,
    );
    const candidates = classifySetupOnboarding(onboardingInstances, {
      library,
      machineId: machineConfig.machineId,
    });
    const globalNames = candidates
      .filter((candidate) =>
        candidate.paths.some((path) =>
          instances.some(
            (instance) =>
              instance.path === path && instance.scope === "global" && !instance.git.repository,
          ),
        ),
      )
      .map((candidate) => candidate.name);
    const shadows = globalNames.length
      ? yield* observeHarnessShadows(options.inventory, { kind: "global" }, globalNames)
      : [];
    const targets = shadows.length ? yield* activeProjectionTargetsEffect(options.inventory) : [];
    const onboarding = candidates.map((candidate) => {
      const matches = shadows.filter((shadow) => shadow.name === candidate.name);
      if (!matches.length) return candidate;
      const destinations = targets.map((target) =>
        join(bindingRoot(target, { kind: "global" }, options.inventory), candidate.name),
      );
      const destinationLinks = matches.flatMap((shadow) =>
        shadow.aliases
          .filter((alias) => isEntryLink(alias) && destinations.includes(alias.path))
          .map((alias) => alias.path),
      );
      return {
        ...candidate,
        shadows: matches,
        ...(destinationLinks.length ? { destinationLinks } : {}),
      };
    });
    const sortedInstances = instances.sort((left, right) => left.path.localeCompare(right.path));
    const recommended = recommendedSetupSelection(
      sortedInstances,
      onboarding,
      options.inventory.home,
    );
    const planId = hashParts([
      canonicalJson({
        candidates: onboarding,
        instances: sortedInstances,
        repositoryConfigs,
        discoveryRoots,
        repositoryDecisions: [...existingDecisions].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        // Consent covers the Library the plan was made against, not only the disk it observed.
        library: libraryStateRevision(library),
      }),
    ]);
    const missingRepositories = !discovering
      ? [...existingDecisions]
          .filter(([path, status]) => status === "watched" && !walk.repositories.includes(path))
          .map(([path]) => path)
          .sort()
      : [];
    const observed = {
      machineConfig: {
        path: machineConfig.path,
        ...(machineConfig.machineId === undefined ? {} : { machineId: machineConfig.machineId }),
        ...(machineConfig.displayName === undefined
          ? {}
          : { displayName: machineConfig.displayName }),
        repositoryRoots: discoveryRoots,
        repositoryDecisions: [...existingDecisions]
          .map(([path, status]) => ({ path, status }))
          .sort((left, right) => left.path.localeCompare(right.path)),
        persisted: options.persistRoots,
      },
      suggestedRepositoryRoots: discoveryRoots.length
        ? []
        : yield* suggestRepositoryRoots(options.inventory.home),
      probes,
      scan: {
        complete: walk.complete && discoveryComplete,
        directoriesExamined: walk.directoriesExamined,
        repositorySearchDepth: 1,
        ...(missingRepositories.length ? { missingRepositories } : {}),
      },
      repositories: walk.repositories.flatMap((repository) => {
        const skills = [
          ...new Set(
            instances
              .filter((instance) => instance.git.repository === repository)
              .map((instance) => instance.name),
          ),
        ].sort();
        return skills.length
          ? [
              {
                path: repository,
                skills,
                status: existingDecisions.get(repository) ?? ("undecided" as const),
              },
            ]
          : [];
      }),
      // Missing config is the normal case, not one diagnostic per repository. Keep the complete
      // internal inventory for planning above, but expose only configured or invalid repositories.
      repositoryConfigs: repositoryConfigs.filter((config) => config.status !== "missing"),
      authoredCollections,
      projections: projections.sort((left, right) =>
        `${left.collectionId}\0${left.skillId}\0${left.path ?? ""}`.localeCompare(
          `${right.collectionId}\0${right.skillId}\0${right.path ?? ""}`,
        ),
      ),
      onboarding: {
        planId,
        candidates: onboarding,
        ...(recommended.sources.length || recommended.copies.length
          ? {
              applyCommand: setupApplyCommandLine({
                planId,
                repositoryRoots: discoveryRoots,
                needsDuplicateDecision: recommended.copies.some((copy) =>
                  onboarding.some(
                    (candidate) =>
                      candidate.paths.includes(copy.sourcePath) && candidate.shadows?.length,
                  ),
                ),
              }),
            }
          : {}),
        recommended,
      },
      locks: [...locks].sort((left, right) => left.path.localeCompare(right.path)),
      instances: sortedInstances,
      brokenLinks: yield* collectBrokenLinks(harnessRoots),
      suppressed: walk.suppressed,
    } satisfies SetupResult;
    return { observed, library };
  },
  (effect, options) =>
    options.persistRoots ? withConfigurationWriter(options.libraryHome, effect) : effect,
);

export const runSetup = (options: SetupOptions) =>
  Effect.map(observeSetup(options), (scan) => scan.observed);

/** Scan once more and hold it to the approved plan ID; a new plan never inherits consent. */
export const revalidateSetupPlan = Effect.fn("Setup.revalidatePlan")(function* (
  options: SetupOptions,
  approvedPlanId: typeof Digest.Type,
) {
  const current = yield* observeSetup({ ...options, persistRoots: false });
  if (current.observed.onboarding.planId !== approvedPlanId)
    return yield* Effect.fail(
      new SetupPlanStale({ approvedPlanId, currentPlanId: current.observed.onboarding.planId }),
    );
  return current;
});
