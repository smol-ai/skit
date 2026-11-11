import { SetupPlanStale } from "../setup-failures.js";
import { Service } from "../service.js";
import type { Interface } from "../library.js";
import { join } from "node:path";

import { Effect } from "effect";
import { canonicalJson } from "../../shared/json.js";
import type { Hash } from "../../shared/hash.js";
import { hashParts } from "../../artifact/descriptor.js";
import { libraryStateRevision } from "../library-state.js";
import { isEntryLink, findDuplicates } from "../routing/duplicates.js";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "../routing/roots.js";
import { setupCollectionGroups } from "./collections.js";
import type { SetupResult } from "./contract.js";
import { collectSetupEvidence, suggestRepositoryRoots } from "./discovery.js";
import { scanSetupCopies } from "./copies.js";
import { planInstalledSkillChanges } from "./installed-skills.js";
import { classifySetupOnboarding } from "./onboarding.js";
import {
  copyConflict,
  recommendedSetupSelection,
  setupDuplicateChoiceRequired,
} from "./decisions.js";

export interface SetupOptions {
  readonly libraryHome: string;
  readonly repositoryRoots?: readonly string[];
  readonly inventory: InventoryRootOptions;
  /** Request saving discovery settings when approved; scanning does not save these settings. */
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
export const scanForSetup = Effect.fn("Library.scan")(function* (
  owner: Pick<Interface, "read" | "plan">,
  options: SetupOptions,
) {
  const evidence = yield* collectSetupEvidence(owner, options);
  const {
    machineConfig,
    discoveryRoots,
    existingDecisions,
    discovering,
    walk,
    repositoryConfigs,
    library,
    authoredCollections,
    discoveryComplete,
    discoveryIssues,
    locks,
  } = evidence;
  const { instances, onboardingInstances, probes, installedSkills } = yield* scanSetupCopies(
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
  const duplicates = globalNames.length
    ? yield* findDuplicates(options.inventory, { kind: "global" }, globalNames)
    : [];
  const targets = duplicates.length ? yield* activeInstallDestinations(options.inventory) : [];
  const onboarding = candidates.map((candidate) => {
    const matches = duplicates.filter((duplicate) => duplicate.name === candidate.name);
    if (!matches.length) return candidate;
    const destinations = targets.map((target) =>
      join(skillsDirectoryFor(target, { kind: "global" }, options.inventory), candidate.name),
    );
    const destinationLinks = matches.flatMap((duplicate) =>
      duplicate.aliases
        .filter((alias) => isEntryLink(alias) && destinations.includes(alias.path))
        .map((alias) => alias.path),
    );
    return {
      ...candidate,
      duplicates: matches,
      ...(destinationLinks.length ? { destinationLinks } : {}),
    };
  });
  const sortedInstances = instances.sort((left, right) => left.path.localeCompare(right.path));
  const installedSkillChanges = yield* planInstalledSkillChanges(owner, evidence.snapshot);
  const recommended = recommendedSetupSelection(
    sortedInstances,
    onboarding,
    options.inventory.home,
  );
  const planId = hashParts([
    canonicalJson({
      candidates: onboarding,
      instances: sortedInstances,
      reconciliation: installedSkillChanges,
      repositoryConfigs,
      discoveryRoots,
      discovery: { complete: walk.complete && discoveryComplete, issues: discoveryIssues },
      repositoryDecisions: [...existingDecisions].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      // Consent covers the Library the plan was made against, not only the disk it observed.
      library: libraryStateRevision(library),
      machine: machineConfig,
    }),
  ]);
  const missingRepositories = !discovering
    ? [...existingDecisions]
        .filter(([path, status]) => status === "watched" && !walk.repositories.includes(path))
        .map(([path]) => path)
        .sort()
    : [];
  const scan = {
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
      persisted: false,
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
      ...(discoveryIssues.length ? { issues: discoveryIssues } : {}),
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
    installedSkills: installedSkills.sort((left, right) =>
      `${left.collectionId}\0${left.skillId}\0${left.path ?? ""}`.localeCompare(
        `${right.collectionId}\0${right.skillId}\0${right.path ?? ""}`,
      ),
    ),
    collectionGroups: setupCollectionGroups({
      instances: sortedInstances,
      installedSkills,
      authoredCollections,
    }),
    onboarding: {
      planId,
      candidates: onboarding,
      ...(recommended.sources.length || recommended.copies.length
        ? {
            apply: {
              repositoryRoots: discoveryRoots,
              needsDuplicateDecision: recommended.copies.some((copy) =>
                setupDuplicateChoiceRequired({
                  conflict: copyConflict(
                    { instances: sortedInstances, onboarding: { candidates: onboarding } },
                    copy,
                  ),
                }),
              ),
            },
          }
        : {}),
      recommended,
    },
    locks: [...locks].sort((left, right) => left.path.localeCompare(right.path)),
    instances: sortedInstances,
    changes: installedSkillChanges,
    brokenLinks: evidence.brokenLinks,
    suppressed: walk.suppressed,
  } satisfies SetupResult;
  return { scan, library };
});

export const runSetup = (options: SetupOptions) =>
  Effect.flatMap(Service, (owner) =>
    Effect.map(scanForSetup(owner, options), (result) => result.scan),
  );

/** Scan once more and hold it to the approved plan ID; a new plan never inherits consent. */
export const revalidateSetupPlan = Effect.fn("Setup.revalidatePlan")(function* (
  options: SetupOptions,
  approvedPlanId: Hash,
) {
  const current = yield* scanForSetup(yield* Service, { ...options, persistRoots: false });
  if (current.scan.onboarding.planId !== approvedPlanId)
    return yield* new SetupPlanStale({
      approvedPlanId,
      currentPlanId: current.scan.onboarding.planId,
    });
  return current;
});

export { SetupPlanStale } from "../setup-failures.js";
