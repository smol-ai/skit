const setupGitStateOrder = [
  "committed",
  "modified",
  "staged",
  "untracked",
  "ignored",
  "mixed",
  "outside-git",
  "unavailable",
] as const;
const setupExpandedSkillLimit = 5;

import { type ContractData, type ContractDataForId } from "../../commands/output-contracts.js";
import { basename, dirname, relative, sep } from "node:path";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import {
  renderInstalledSkillChange,
  renderChangeResult,
  renderSetupVersionChoice,
  renderReviewedChanges,
} from "../presentation/installed-skill-changes.js";

function renderSetupCollections(data: ContractDataForId<"skit.setup.v12">): string[] {
  type Instance = (typeof data.instances)[number];
  type Collection = {
    label: string;
    instances: Instance[];
  };
  const installed = new Map<string, Collection>();
  const repositoryRoots = new Map<string, Collection>();
  const loose: Instance[] = [];

  for (const instance of data.instances.filter(
    (item) => item.owner.kind !== "skit" && item.owner.kind !== "authored",
  )) {
    const sourceLock = instance.locks[0];
    if (sourceLock) {
      const collection = installed.get(sourceLock.entry.source) ?? {
        label: sourceLock.entry.source,
        instances: [],
      };
      collection.instances.push(instance);
      installed.set(sourceLock.entry.source, collection);
      continue;
    }

    const repository = instance.git.repository;
    if (!repository) {
      loose.push(instance);
      continue;
    }

    const root = dirname(instance.path);
    const key = `${repository}:${root}`;
    const rootLabel = relative(repository, root) || ".";
    const rootSegments = rootLabel.split(sep);
    const isConventionalCollectionRoot =
      rootSegments.at(-1) === "skills" && rootSegments.length <= 2;
    if (!isConventionalCollectionRoot) {
      loose.push(instance);
      continue;
    }
    const collection = repositoryRoots.get(key) ?? {
      label: `${basename(repository)} · ${rootLabel}`,
      instances: [],
    };
    collection.instances.push(instance);
    repositoryRoots.set(key, collection);
  }

  const repositoryCollections: Collection[] = [];
  for (const collection of repositoryRoots.values()) {
    const names = new Set(collection.instances.map((instance) => instance.name));
    if (names.size > 1) repositoryCollections.push(collection);
    else loose.push(...collection.instances);
  }

  const renderCollection = (collection: Collection): string[] => {
    const names = [...new Set(collection.instances.map((instance) => instance.name))].sort();
    const states = setupGitStateOrder.flatMap((status) => {
      const count = collection.instances.filter(
        (instance) => instance.git.status === status,
      ).length;
      return count ? [`${count} ${status}`] : [];
    });
    const harnesses = [...new Set(collection.instances.flatMap((instance) => instance.harnesses))]
      .sort()
      .map(harnessLabel);
    return [
      `  ${collection.label} · ${names.length} skill${names.length === 1 ? "" : "s"}${collection.instances.length === names.length ? "" : ` · ${collection.instances.length} instances`}`,
      ...(names.length <= setupExpandedSkillLimit ? [`    ${names.join(", ")}`] : []),
      `    ${states.join(" · ")}${harnesses.length ? ` · ${harnesses.join(", ")}` : ""}`,
    ];
  };

  const lines: string[] = [];
  if (installed.size)
    lines.push(
      "Installed collections",
      ...[...installed.values()]
        .sort((left, right) => left.label.localeCompare(right.label))
        .flatMap(renderCollection),
    );
  if (repositoryCollections.length)
    lines.push(
      ...(lines.length ? [""] : []),
      "Repository collections (inferred)",
      ...repositoryCollections
        .sort((left, right) => left.label.localeCompare(right.label))
        .flatMap(renderCollection),
    );
  if (loose.length) {
    const names = [...new Set(loose.map((instance) => instance.name))].sort();
    const scopes = new Map<string, number>();
    for (const instance of loose) scopes.set(instance.scope, (scopes.get(instance.scope) ?? 0) + 1);
    lines.push(
      ...(lines.length ? [""] : []),
      "Loose skills",
      `  ${names.length} skill${names.length === 1 ? "" : "s"}${loose.length === names.length ? "" : ` · ${loose.length} instances`}`,
      ...(names.length <= setupExpandedSkillLimit ? [`    ${names.join(", ")}`] : []),
      `    ${[...scopes.entries()].map(([scope, count]) => `${count} ${scope}`).join(" · ")}`,
    );
  }
  return lines;
}

function renderSetupInstalledSkills(
  installedSkills: ContractDataForId<"skit.setup.v12">["installedSkills"],
): string[] {
  const collections = new Map<string, (typeof installedSkills)[number][]>();
  for (const installedSkill of installedSkills) {
    const group = installedSkill.collectionId ?? installedSkill.skillId;
    collections.set(group, [...(collections.get(group) ?? []), installedSkill]);
  }
  return [...collections.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, installedSkills]) => {
      const names = [
        ...new Set(installedSkills.map((installedSkill) => installedSkill.name)),
      ].sort();
      const statuses = ["current", "modified", "missing"] as const;
      const counts = statuses.flatMap((status) => {
        const count = installedSkills.filter(
          (installedSkill) => installedSkill.status === status,
        ).length;
        return count ? [`${count} ${status}`] : [];
      });
      const harnesses = [
        ...new Set(installedSkills.flatMap((installedSkill) => installedSkill.harnesses)),
      ]
        .sort()
        .map(harnessLabel);
      return [
        `  ${installedSkills[0]!.collectionDisplayName} · ${names.length} skill${names.length === 1 ? "" : "s"}${installedSkills.length === names.length ? "" : ` · ${installedSkills.length} installed copies`}`,
        ...(names.length <= setupExpandedSkillLimit ? [`    ${names.join(", ")}`] : []),
        `    ${counts.join(" · ")}${harnesses.length ? ` · ${harnesses.join(", ")}` : ""}`,
      ];
    });
}

function renderSetupAuthoredCollections(data: ContractDataForId<"skit.setup.v12">): string[] {
  return data.authoredCollections.flatMap((collection) => {
    const installedSkills = data.installedSkills.filter(
      (installedSkill) => installedSkill.collectionId === collection.collectionId,
    );
    const statuses = ["current", "modified", "missing"] as const;
    const installedSkillSummary = statuses.flatMap((status) => {
      const count = installedSkills.filter(
        (installedSkill) => installedSkill.status === status,
      ).length;
      return count ? [`${count} ${status}`] : [];
    });
    const names = collection.skills.map((skill) => skill.name);
    return [
      `  ${collection.namespace}/${collection.skit} · ${collection.repository}`,
      `    ${names.length} authored skill${names.length === 1 ? "" : "s"} · library ${collection.collectionId ? "present" : "missing"}${installedSkillSummary.length ? ` · ${installedSkillSummary.join(" · ")} installed cop${installedSkills.length === 1 ? "y" : "ies"}` : ""}`,
      ...(names.length <= setupExpandedSkillLimit ? [`    ${names.join(", ")}`] : []),
      `    ${collection.origin}`,
    ];
  });
}

function renderSetupContentMatches(data: ContractDataForId<"skit.setup.v12">): string[] {
  const candidates = data.instances.filter(
    (instance) => instance.owner.kind === "unknown" && instance.locks.length === 0,
  );
  const libraryMatches = candidates.filter(
    (instance) => instance.contentIdentity.libraryMatches.length > 0,
  );
  const duplicateHashes = new Map<string, typeof candidates>();
  for (const instance of candidates) {
    const hash = instance.contentIdentity.currentHash;
    if (hash) duplicateHashes.set(hash, [...(duplicateHashes.get(hash) ?? []), instance]);
  }
  const duplicates = [...duplicateHashes.values()]
    .filter((instances) => instances.length > 1)
    .sort((left, right) => left[0]!.name.localeCompare(right[0]!.name));
  const lines: string[] = [];
  if (libraryMatches.length)
    lines.push(
      "Exact Library matches",
      ...libraryMatches
        .sort((left, right) => left.path.localeCompare(right.path))
        .flatMap((instance) => [
          `  ${instance.name} · ${instance.git.status}`,
          `    ${instance.path}`,
          `    matches ${[...new Set(instance.contentIdentity.libraryMatches.map((match) => match.name))].join(", ")}`,
        ]),
    );
  if (duplicates.length)
    lines.push(
      ...(lines.length ? [""] : []),
      "Equivalent unmanaged copies",
      ...duplicates.flatMap((instances) => {
        const names = [...new Set(instances.map((instance) => instance.name))].sort();
        return [
          `  ${names.join(", ")} · ${instances.length} identical instances`,
          ...instances.map((instance) => `    ${instance.path}`),
        ];
      }),
    );
  return lines;
}

/** What `skit setup --apply` would do, and the exact command that does it. */
function renderSetupRecommendation(data: ContractDataForId<"skit.setup.v12">): string[] {
  const { candidates, recommended } = data.onboarding;
  if (!recommended.sources.length && !recommended.copies.length) return [];
  const duplicates = recommended.copies.filter((copy) =>
    candidates.some(
      (candidate) => candidate.paths.includes(copy.sourcePath) && candidate.duplicates?.length,
    ),
  );
  return [
    "",
    "Recommended plan",
    ...recommended.sources.map(
      ({ source, names }) => `  Import skills.sh Collection ${source}: ${names.join(", ")}`,
    ),
    ...(recommended.copies.length
      ? [`  Add to Library: ${recommended.copies.map((copy) => copy.name).join(", ")}`]
      : []),
    ...(duplicates.length
      ? [
          `  Already visible to agents elsewhere: ${duplicates.map((copy) => copy.name).join(", ")} (choose --duplicates retain-only, keep-both or retire-aliases)`,
        ]
      : []),
    ...(data.onboarding.applyCommand === undefined
      ? []
      : ["Apply it without prompts:", `  ${data.onboarding.applyCommand}`]),
  ];
}

export /** What `skit setup --apply` did, then why the rest was left alone. */
function renderSetupApplied(data: ContractDataForId<"skit.setup.applied.v4">): string {
  const lines = [
    ...data.imported.map(({ source, names }) => `Imported ${source}: ${names.join(", ")}`),
    ...(data.added.length
      ? [`Added to Library: ${data.added.map((copy) => copy.name).join(", ")}`]
      : []),
    ...(data.reconnected.length
      ? [`Reconnected: ${data.reconnected.map((copy) => copy.name).join(", ")}`]
      : []),
  ];
  if (!lines.length)
    lines.push(
      data.changes?.some((outcome) => outcome.status === "updated")
        ? "Updated existing managed copies."
        : data.changes?.some((outcome) => outcome.status === "pending")
          ? "Existing managed copies need a fresh review."
          : "Nothing to apply; the plan recommended no changes.",
    );
  if (data.installedSkills.length)
    lines.push(
      "",
      "Copies",
      ...data.installedSkills.map(
        (installedSkill) =>
          `  ${installedSkill.name} · ${installedSkill.destination} · ${installedSkill.status} · ${installedSkill.path}`,
      ),
    );
  if (data.changes?.length)
    lines.push("", "Existing managed copies", ...data.changes.map(renderChangeResult));
  if (data.leftAlone.length)
    lines.push(
      "",
      "Left alone",
      ...data.leftAlone.map((skill) => `  ${skill.name} · ${skill.reason}`),
    );
  if (data.aliasRecoveryDirectories?.length)
    lines.push(
      "",
      "Backed-up copies and their move records are saved in",
      ...data.aliasRecoveryDirectories.map((directory) => `  ${directory}`),
    );
  const backupWarnings = data.backupWarnings ?? data.aliasesKept;
  if (backupWarnings?.length)
    lines.push(
      "",
      "Existing copies left in place",
      ...backupWarnings.map((kept) => `  ${kept.name} · ${kept.message}`),
    );
  return lines.join("\n");
}

export function renderSetup(data: ContractDataForId<"skit.setup.v12">): string {
  const lines = [
    `Observed ${data.instances.length} skill instance(s) in ${data.repositories.length} repositories across ${data.machineConfig.repositoryRoots.length} configured root(s)${data.machineConfig.persisted ? " · roots saved for this machine" : ""}`,
    `Scan ${data.scan.complete ? "complete" : "incomplete"} · ${data.scan.directoriesExamined} directories examined · repository depth ${data.scan.repositorySearchDepth}`,
    "",
    ...(data.scan.issues?.length
      ? [
          "Discovery issues",
          ...data.scan.issues.map((issue) => `  ${issue.code} · ${issue.path}`),
          "",
        ]
      : []),
    "Harnesses",
    ...data.probes.map(
      (probe) => `  ${harnessLabel(probe.harness)} · ${probe.status} · ${probe.command}`,
    ),
  ];
  if (data.repositories.length) {
    lines.push("", `Repositories (${data.repositories.length})`);
    for (const repository of data.repositories)
      lines.push(
        `  ${repository.path} · ${repository.skills.length} skill${repository.skills.length === 1 ? "" : "s"} discovered`,
      );
  }
  const configuredRepositories = data.repositoryConfigs.filter(
    (config) => config.status !== "missing",
  );
  if (configuredRepositories.length) {
    lines.push("", "Repository discovery config");
    for (const config of configuredRepositories)
      lines.push(
        `  ${config.repository} · ${config.status} · ${config.exclude.length} exclusion${config.exclude.length === 1 ? "" : "s"} · ${config.collections.length} collection root${config.collections.length === 1 ? "" : "s"}\n    ${config.path}`,
      );
  }
  if (data.authoredCollections.length)
    lines.push("", "Authored SKITs", ...renderSetupAuthoredCollections(data));
  const authoredCollectionIds = new Set(
    data.authoredCollections.flatMap((collection) =>
      collection.collectionId ? [collection.collectionId] : [],
    ),
  );
  const externalInstalledSkills = data.installedSkills.filter(
    (installedSkill) =>
      installedSkill.collectionId === undefined ||
      !authoredCollectionIds.has(installedSkill.collectionId),
  );
  if (externalInstalledSkills.length)
    lines.push(
      "",
      "Existing SKIT installed skills",
      ...renderSetupInstalledSkills(externalInstalledSkills),
    );
  if (data.changes?.length)
    lines.push(
      "",
      "Existing copy reconciliation",
      ...data.changes.map((fact) => renderInstalledSkillChange(fact)),
    );
  const contentMatches = renderSetupContentMatches(data);
  if (contentMatches.length) lines.push("", ...contentMatches);
  if (data.onboarding.candidates.length) {
    lines.push("", `Onboarding plan · ${data.onboarding.planId.slice(0, 12)}`);
    const actions = new Map<
      (typeof data.onboarding.candidates)[number]["action"],
      (typeof data.onboarding.candidates)[number][]
    >();
    for (const candidate of data.onboarding.candidates)
      actions.set(candidate.action, [...(actions.get(candidate.action) ?? []), candidate]);
    for (const action of [
      "import-observed-collection",
      "bind-existing-entry",
      "manage-locally",
      "repository-owned",
      "blocked",
      "leave-alone",
    ] as const) {
      const candidates = actions.get(action);
      if (!candidates) continue;
      lines.push(`  ${action} · ${candidates.length} skill${candidates.length === 1 ? "" : "s"}`);
      if (candidates.length <= 5)
        for (const candidate of candidates)
          lines.push(
            `    ${candidate.name}${candidate.action === "blocked" ? ` · ${candidate.reason}` : candidate.action === "manage-locally" && candidate.sourceSelection === "required" ? " · choose source copy" : ""}\n      ${candidate.paths.join("\n      ")}`,
          );
      else if (action === "blocked") {
        const reasons = new Map<string, number>();
        for (const candidate of candidates)
          if (candidate.action === "blocked")
            reasons.set(candidate.reason, (reasons.get(candidate.reason) ?? 0) + 1);
        for (const [reason, count] of reasons) lines.push(`    ${count} · ${reason}`);
      }
    }
  }
  lines.push(...renderSetupRecommendation(data));
  if (data.suggestedRepositoryRoots.length)
    lines.push(
      "",
      `Repositories under ${data.suggestedRepositoryRoots.join(", ")} were not scanned. To include their skills:`,
      ...data.suggestedRepositoryRoots.map((root) => `  skit setup --work-dir ${root}`),
    );
  const collections = renderSetupCollections(data);
  if (collections.length) lines.push("", "Skill collections", ...collections);
  if (data.instances.length) {
    lines.push("", "Skill instances");
    for (const item of data.instances) {
      const ownerLabel =
        item.owner.kind === "pnpm"
          ? `Managed by pnpm · ${item.owner.package}@${item.owner.version} · left in place`
          : item.owner.kind === "authored"
            ? "author-source"
            : item.owner.kind;
      lines.push(
        `  ${item.name} · ${item.scope} · ${ownerLabel} · ${item.git.status}${item.harnesses.length ? ` · ${item.harnesses.map(harnessLabel).join(", ")}` : ""}\n    ${item.path}`,
      );
    }
  }
  if (data.locks.length)
    lines.push(
      "",
      "skills.sh locks",
      ...data.locks.map((lock) => `  ${lock.scope} · ${lock.status}\n    ${lock.path}`),
    );
  if (data.brokenLinks.length)
    lines.push(
      "",
      "Broken links",
      ...data.brokenLinks.map((link) => `  ${link.path} -> ${link.target}`),
    );
  if (!data.instances.length) lines.push("", "No skill instances observed.");
  return lines.join("\n");
}

export const renderSetupComparison = (data: ContractData<"setupComparison">) =>
  [
    ...data.copies.map(
      (copy) =>
        `${copy.name} · ${copy.path}\n${copy.currentHash}\n${copy.markdown}${copy.truncated ? "\n[Preview truncated]" : ""}`,
    ),
    ...data.actions.map(
      (action) => `${action.rel}: ${action.argv.map((arg) => JSON.stringify(arg)).join(" ")}`,
    ),
  ].join("\n\n");

export const renderSetupReview = (data: ContractData<"setupReview">) =>
  [
    !data.canApply
      ? "Resolve existing copy choices before applying"
      : data.hasChanges
        ? "Review setup changes"
        : "Nothing to apply",
    ...(data.summary.sourceUpdateMayNeedReview
      ? [
          "Source imports that change an existing active version require a fresh setup review before those copies are updated.",
        ]
      : []),
    ...data.summary.versionChoices.map((choice) =>
      renderSetupVersionChoice(choice, data.summary.changes),
    ),
    ...data.summary.changes.map((fact) => renderReviewedChanges(fact, data.summary.versionChoices)),
    ...data.summary.sources.map((source) => `Import ${source.source}: ${source.names.join(", ")}`),
    ...data.summary.enables.map((copy) => `Enable ${copy.name} from ${copy.path}`),
    ...data.summary.retains.map((copy) => `Retain ${copy.name} from ${copy.path}`),
    ...data.summary.preserves.map(
      (copy) => `Preserve ${copy.kind} ${copy.name} from ${copy.path} in recovery`,
    ),
    ...data.summary.removals.map((copy) => `Save ${copy.name} from ${copy.path} in recovery`),
    ...(data.summary.savesMachineSettings ? ["Save the selected machine discovery settings"] : []),
    `Review: ${data.reviewId}`,
    ...data.actions.map(
      (action) => `${action.rel}: ${action.argv.map((arg) => JSON.stringify(arg)).join(" ")}`,
    ),
  ].join("\n");

export const renderSetupFailed = (data: ContractData<"setupFailed">) =>
  [
    data.message,
    data.remediation,
    ...data.actions.map(
      (action) => `${action.rel}: ${action.argv.map((arg) => JSON.stringify(arg)).join(" ")}`,
    ),
  ].join("\n");
