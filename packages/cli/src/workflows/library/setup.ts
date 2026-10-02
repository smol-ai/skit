import { Effect, Schema } from "effect";
import { canonicalJson, Digest, hashParts } from "@smolai/skit-core";
import { observeHarnessShadows } from "../../projection/harness-shadows.js";
import type { InventoryRootOptions } from "../../projection/roots.js";
import type { SetupResult } from "./setup-contract.js";
import { collectSetupEvidence, collectBrokenLinks } from "./setup-discovery.js";
import { observeSetupCopies } from "./setup-observation.js";
import { classifySetupOnboarding } from "./setup-onboarding.js";
export {
  SetupConfigUnusable,
  readSetupMachineConfig,
  updateSetupRepositoryDecision,
  setupDiscoveryRoots,
  setupRepositoryDecisions,
} from "./setup-config.js";
export { collectHarnessRoots } from "./setup-discovery.js";
export { classifyObservedOwner, isSetupCandidateFromCodex } from "./setup-onboarding.js";
export { classifySetupOnboarding, setupInstanceGroupKey } from "./setup-onboarding.js";
export { setupLockCollection, setupLockGroupKey } from "./skills-sh-lock-source.js";
export { computeSkillsShCompatibleHash as computeSkillsLockCompatibleHash } from "./skills-sh-compatible-hash.js";
export class SetupPlanStale extends Schema.TaggedError<SetupPlanStale>()("SetupPlanStale", {
  approvedPlanId: Digest,
  currentPlanId: Digest,
}) {
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

export const runSetup = Effect.fn("Library.setup")(function* (options: SetupOptions) {
  const evidence = yield* collectSetupEvidence(options);
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
    repositoryScans,
    locks,
  } = evidence;
  const { instances, probes, projections } = yield* observeSetupCopies(
    evidence,
    options.inventory.home,
    options.probePath,
  );
  const candidates = classifySetupOnboarding(instances, {
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
  const onboarding = candidates.map((candidate) => {
    const matches = shadows.filter((shadow) => shadow.name === candidate.name);
    return matches.length ? { ...candidate, shadows: matches } : candidate;
  });
  const sortedInstances = instances.sort((left, right) => left.path.localeCompare(right.path));
  const planId = hashParts([
    canonicalJson({
      candidates: onboarding,
      instances: sortedInstances,
      repositoryConfigs,
    }),
  ]);
  const missingRepositories = !discovering
    ? [...existingDecisions]
        .filter(([path, status]) => status === "watched" && !walk.repositories.includes(path))
        .map(([path]) => path)
        .sort()
    : [];
  return {
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
    probes,
    scan: {
      complete:
        walk.complete &&
        repositoryScans.every((scan) => scan.complete) &&
        repositoryConfigs.every((config) => ["missing", "valid"].includes(config.status)),
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
    onboarding: { planId, candidates: onboarding },
    locks: [...locks].sort((left, right) => left.path.localeCompare(right.path)),
    instances: sortedInstances,
    brokenLinks: yield* collectBrokenLinks(harnessRoots),
    suppressed: walk.suppressed,
  } satisfies SetupResult;
});

export const revalidateSetupPlan = Effect.fn("Setup.revalidatePlan")(function* (
  options: SetupOptions,
  approvedPlanId: typeof Digest.Type,
) {
  const current = yield* runSetup({ ...options, persistRoots: false });
  if (current.onboarding.planId !== approvedPlanId)
    return yield* Effect.fail(
      new SetupPlanStale({ approvedPlanId, currentPlanId: current.onboarding.planId }),
    );
  return current;
});
