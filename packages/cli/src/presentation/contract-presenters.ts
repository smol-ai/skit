import {
  outputContracts,
  type ContractDataForId,
  type ContractId,
} from "../commands/output-contracts.js";
import { homedir } from "node:os";
import { basename, dirname, relative, sep } from "node:path";
import { harnessLabel } from "../harness/catalog.js";
import { renderInventory } from "./inventory.js";
import { renderSetEnabled } from "./set-enabled.js";
import { renderPin } from "./pin.js";
import { renderRemove, renderRemovePlan } from "./remove.js";
import { renderCheck } from "./check.js";
import { renderLibrarySync } from "./library-sync.js";
import { renderLibraryList } from "./library-list.js";
import { renderAuditV1Alpha4 } from "./audit.js";
import { conditionHeadline, severityHeadline } from "./condition-language.js";

export interface RenderContext {
  readonly color: boolean;
  readonly detail: "summary" | "full";
}

type ContractPresenters = {
  [I in ContractId]?: (data: ContractDataForId<I>, context: RenderContext) => string;
};

const renderLibraryHistoryEvent = (
  event: ContractDataForId<"skit.library.history.v1">["events"][number],
) => {
  const actions = new Map<string, number>();
  for (const change of event.changes)
    actions.set(change.action, (actions.get(change.action) ?? 0) + 1);
  const summary = [...actions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([action, count]) => `${count} ${action}`)
    .join(" · ");
  const count = `${event.changes.length} ${event.changes.length === 1 ? "change" : "changes"}`;
  return `${event.occurredAt}  ${event.type}  ${count}${summary ? ` · ${summary}` : ""}`;
};

function renderValidation(data: ContractDataForId<"skit.validate.v3">): string {
  const headline = {
    valid: "SKIT is valid",
    "valid-with-warnings": "SKIT is valid with warnings",
    "policy-blocked": "SKIT is structurally valid but blocked by security policy",
    invalid: "SKIT validation failed",
  }[data.status];
  if (!data.diagnostics.length) return headline;

  return [
    headline,
    "",
    ...data.diagnostics.flatMap((diagnostic) => [
      `${severityHeadline(diagnostic.severity)}${diagnostic.path ? ` · ${diagnostic.path}` : ""}`,
      `  ${diagnostic.message}`,
    ]),
  ].join("\n");
}

function renderSecurityReview(data: ContractDataForId<"skit.security.review.v2">): string {
  return data.audit.findings.length
    ? data.assessment.findingDecisions
        .map((finding) => `${finding.fingerprint} ${finding.disposition} (${finding.ruleId})`)
        .join("\n")
    : "No security findings";
}

function renderAuthorInit(data: ContractDataForId<"skit.init.v1">): string {
  const lines = [`Initialized SKIT at ${data.path}`];
  if (data.library_registration === "removed")
    lines.push("Library Entry remains removed; run `skit author init --register` to restore it");
  if (data.discovered?.skillEntries.length) {
    lines.push("", "Discovered Skills:");
    for (const skill of data.discovered.skillEntries) lines.push(`  ${skill.name} · ${skill.path}`);
  }
  return lines.join("\n");
}

function renderAuthorInvocation(data: ContractDataForId<"skit.author.invocation.v1">): string {
  const changed = data.generated.filter((item) => item.changed);
  if (!changed.length)
    return "Every declared invocation policy is already written into its Harness metadata";
  return [
    data.dryRun
      ? "These files do not yet express their declared invocation policy:"
      : "Wrote the declared invocation policy into:",
    ...changed.map((item) => `  ${item.path} (${item.skill}, ${item.harness}, ${item.policy})`),
  ].join("\n");
}

function renderAuthorDelete(data: ContractDataForId<"skit.author.delete.v1">): string {
  const releases = data.release_versions.join(", ") || "none";
  if (data.status === "delete_ready")
    return `Would delete ${data.skit_id}: ${data.draft_revisions} Draft Revision(s), Releases: ${releases}`;
  if (data.status === "absent") return `${data.skit_id} is already absent`;
  return `Deleted ${data.skit_id}: ${data.draft_revisions} Draft Revision(s), Releases: ${releases}${data.archive_cleanup === "deferred" ? "; archive cleanup deferred" : ""}`;
}

function renderUpdate(data: ContractDataForId<"skit.update.v4">): string {
  if (!data.length) return "No device-local Sources to update";
  const updated = data.filter((item) => item.changed).length;
  const current = data.length - updated;
  if (updated === 0)
    return `Everything is current\n${current} Source${current === 1 ? "" : "s"} checked; no retained snapshots or projected Skills changed.`;
  const projected = data.reduce((total, item) => total + item.projected, 0);
  const deferred = data.reduce((total, item) => total + item.deferred, 0);
  const lines = [
    "Update complete",
    `${updated} Source${updated === 1 ? "" : "s"} updated${current ? `; ${current} already current` : ""}.`,
  ];
  if (projected)
    lines.push(
      `${projected} projected Skill${projected === 1 ? "" : "s"} updated${deferred ? `; ${deferred} deferred` : ""}.`,
    );
  else if (deferred)
    lines.push(`${deferred} projected Skill${deferred === 1 ? "" : "s"} deferred.`);
  return lines.join("\n");
}

function registryLabel(registry: string): string {
  try {
    return new URL(registry).host;
  } catch {
    return registry;
  }
}

function authoredSkitLabel(identity: string): string {
  try {
    return new URL(identity).pathname.replace(/^\//, "");
  } catch {
    return identity;
  }
}

function renderAuthorList(data: ContractDataForId<"skit.author.list.v1">): string {
  const registry = registryLabel(data.registry);
  if (!data.skits.length) return `No authored SKITs · ${registry}`;
  const rows = data.skits.map((skit) => [
    authoredSkitLabel(skit.identity),
    skit.visibility,
    skit.most_recent_release_version ?? "—",
  ]);
  const headings = ["SKIT", "ACCESS", "LATEST"];
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column].length)),
  );
  const format = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  return [
    `${data.skits.length} authored ${data.skits.length === 1 ? "SKIT" : "SKITs"} · ${registry}`,
    "",
    format(headings),
    ...rows.map(format),
  ].join("\n");
}

function renderDoctor(data: ContractDataForId<"skit.doctor.v2">): string {
  if (!data.issues.length) return "Local library is healthy";
  return [
    `${data.issues.length} ${data.issues.length === 1 ? "issue" : "issues"}`,
    "",
    ...data.issues.flatMap((issue) => [
      `${conditionHeadline(issue.code, "Local library issue")}${issue.skillId ? ` · ${issue.skillId}` : ""}${issue.harness ? ` · ${harnessLabel(issue.harness)}` : issue.harnesses?.length ? ` · ${issue.harnesses.map(harnessLabel).join(", ")}` : ""}`,
      ...(issue.path ? [`  ${issue.path}`] : []),
    ]),
  ].join("\n");
}

function renderRegistryChange(data: ContractDataForId<"skit.registry.remote.v1">): string {
  if (data.action === "removed") return `Removed Registry ${data.name}`;
  if (data.action === "defaulted") return `Default Registry: ${data.name}  ${data.origin}`;
  return `${data.name}  ${data.origin}`;
}

function renderRegistryList(data: ContractDataForId<"skit.registry.list.v1">): string {
  return data.registries.length
    ? data.registries
        .map(
          (registry) =>
            `${registry.name}${registry.isDefault ? " (default)" : ""}  ${registry.origin}`,
        )
        .join("\n")
    : "No Registries configured";
}

const authScopeLabels: Readonly<Record<string, string>> = {
  "library:sync": "Library sync",
  "authoring:write": "authoring",
  "publication:write": "publication",
};

function renderAuthAccess(scopes: ReadonlyArray<string>): string {
  if (!scopes.length) return "Unknown";
  return scopes.map((scope) => authScopeLabels[scope] ?? scope).join(", ");
}

function renderAuthExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return "Unknown";
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return expiresAt;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expiry);
}

function renderAuthStatus(
  data: ContractDataForId<"skit.auth.status.v2">,
  context: RenderContext,
): string {
  if (!data.credentials.length) return "No credentials configured; run `skit auth login`";
  return data.credentials
    .map((credential) => {
      const name = credential.aliases.join(", ") || credential.origin;
      const flags = [
        credential.isDefault ? "default" : undefined,
        credential.source === "environment" ? "environment" : undefined,
      ].filter(Boolean);
      return [
        `Credential configured for ${name}${flags.length ? ` (${flags.join(", ")})` : ""}`,
        ...(credential.aliases.length ? [`Registry: ${credential.origin}`] : []),
        `Access: ${renderAuthAccess(credential.scopes)}`,
        `Expires: ${renderAuthExpiry(credential.expiresAt)}${credential.expired ? " (expired)" : ""}`,
        ...(context.detail === "full" ? [`Credential: ${credential.tokenPrefix}`] : []),
      ].join("\n");
    })
    .join("\n\n");
}

function renderAuthLogin(
  data: ContractDataForId<"skit.auth.login.v1">,
  context: RenderContext,
): string {
  const name = data.alias ?? data.origin;
  return [
    `Authenticated to ${name}${data.defaultRegistry ? " (default)" : ""}`,
    ...(data.alias ? [`Registry: ${data.origin}`] : []),
    `Access: ${renderAuthAccess(data.scopes)}`,
    `Expires: ${renderAuthExpiry(data.expiresAt)}`,
    ...(context.detail === "full" ? [`Credential: ${data.tokenPrefix}`] : []),
    ...(data.warning ? [`Warning: ${data.warning}`] : []),
  ].join("\n");
}

function renderHarnessProbe(
  data: ContractDataForId<"skit.experimental.harness-probe.v1alpha1">,
): string {
  return data.probes
    .map((probe) =>
      [
        harnessLabel(probe.harnessId),
        `  Status: ${{ installed: "Installed", missing: "Not installed", failed: "Probe failed" }[probe.status]}`,
        `  executable: ${probe.executablePath ?? "not found"}`,
        `  resolved: ${probe.resolvedPath ?? "n/a"}`,
        `  version: ${probe.version ?? "unknown"}`,
        ...(probe.error ? [`  error: ${probe.error}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}

function renderAuthorSync(data: ContractDataForId<"skit.author.sync.v3">): string {
  if (data.status === "first_sync_ready")
    return `First Draft sync ready for ${data.identity.locator} (${data.visibility}); no Release will be published; rerun with --apply`;
  if (data.status === "merge_ready")
    return `Draft merge ready (${data.paths.length} path(s)); rerun with --apply`;
  const headline = {
    created: "Created the remote Draft",
    bound: "Connected this workspace to its remote Draft",
    clean: "Draft is already synchronized",
    merged: "Merged local and remote Draft changes",
    conflicted: "Draft sync needs conflict resolution",
    unbound_conflict: "Draft sync needs conflict resolution before this workspace can be connected",
  }[data.status];
  return `${headline}${"revision_id" in data ? ` (${data.revision_id})` : ""}`;
}

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

const compactSetupPath = (path: string): string => {
  const home = homedir();
  return path === home
    ? "~"
    : path.startsWith(`${home}${sep}`)
      ? `~${path.slice(home.length)}`
      : path;
};

type SetupDiscoveryInput = {
  readonly instances: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly locks: ReadonlyArray<{
    readonly path: string;
    readonly status: string;
    readonly entries: ReadonlyArray<{
      readonly name: string;
      readonly source: string;
      readonly computedHash?: string;
      readonly skillFolderHash?: string;
    }>;
  }>;
};

export function setupDiscoverySummary(data: SetupDiscoveryInput) {
  const skills = new Map<string, string[]>();
  for (const instance of data.instances)
    skills.set(instance.name, [...(skills.get(instance.name) ?? []), instance.path]);

  return {
    skills: {
      count: skills.size,
      locations: data.instances.length,
      expanded: skills.size <= setupExpandedSkillLimit,
      items: [...skills]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, paths]) => ({ name, paths: paths.sort() })),
    },
    lockFiles: [...data.locks]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((lock) => {
        const collections = new Map<
          string,
          Array<{ name: string; computedHash?: string; skillFolderHash?: string }>
        >();
        for (const entry of lock.entries)
          collections.set(entry.source, [
            ...(collections.get(entry.source) ?? []),
            {
              name: entry.name,
              ...(entry.computedHash ? { computedHash: entry.computedHash } : {}),
              ...(entry.skillFolderHash ? { skillFolderHash: entry.skillFolderHash } : {}),
            },
          ]);
        return {
          directory: dirname(lock.path),
          status: lock.status,
          collections: [...collections]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([source, entries]) => {
              const skills = entries.sort((left, right) => left.name.localeCompare(right.name));
              return {
                source,
                skills,
                expanded: skills.length <= setupExpandedSkillLimit,
              };
            }),
        };
      }),
  };
}

export function renderSetupDiscovery(data: SetupDiscoveryInput): string {
  const summary = setupDiscoverySummary(data);

  const lines = [
    `Found ${summary.skills.count} skill${summary.skills.count === 1 ? "" : "s"}${summary.skills.locations === summary.skills.count ? "" : ` across ${summary.skills.locations} locations`}`,
  ];
  if (summary.skills.expanded)
    for (const { name, paths } of summary.skills.items)
      if (paths.length === 1) lines.push(`  ${name} · ${compactSetupPath(paths[0]!)}`);
      else {
        lines.push(`  ${name} · ${paths.length} locations`);
        lines.push(...paths.sort().map((path) => `    ${compactSetupPath(path)}`));
      }

  lines.push(
    "",
    `Found ${summary.lockFiles.length} skills.sh lock file${summary.lockFiles.length === 1 ? "" : "s"}`,
  );
  for (const lock of summary.lockFiles) {
    lines.push(`  ${compactSetupPath(lock.directory)}`);
    if (!lock.collections.length) lines.push(`    ${lock.status}`);
    for (const collection of lock.collections) {
      lines.push(
        `    ${collection.source} · ${collection.skills.length} skill${collection.skills.length === 1 ? "" : "s"}`,
      );
      if (collection.expanded)
        lines.push(
          ...collection.skills.map((skill) => {
            const hashes = [
              ...(skill.computedHash ? [`computedHash ${skill.computedHash}`] : []),
              ...(skill.skillFolderHash ? [`skillFolderHash ${skill.skillFolderHash}`] : []),
            ];
            return `      ${skill.name} · ${hashes.join(" · ") || "no recorded hash"}`;
          }),
        );
    }
  }
  return lines.join("\n");
}

function renderSetupCollections(data: ContractDataForId<"skit.setup.v5">): string[] {
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

function renderSetupProjections(
  projections: ContractDataForId<"skit.setup.v5">["projections"],
): string[] {
  const collections = new Map<string, (typeof projections)[number][]>();
  for (const projection of projections) {
    const group = projection.collectionId ?? projection.skillId;
    collections.set(group, [...(collections.get(group) ?? []), projection]);
  }
  return [...collections.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, projections]) => {
      const names = [...new Set(projections.map((projection) => projection.name))].sort();
      const statuses = ["current", "modified", "missing"] as const;
      const counts = statuses.flatMap((status) => {
        const count = projections.filter((projection) => projection.status === status).length;
        return count ? [`${count} ${status}`] : [];
      });
      const harnesses = [...new Set(projections.flatMap((projection) => projection.harnesses))]
        .sort()
        .map(harnessLabel);
      return [
        `  ${projections[0]!.collectionDisplayName} · ${names.length} skill${names.length === 1 ? "" : "s"}${projections.length === names.length ? "" : ` · ${projections.length} projections`}`,
        ...(names.length <= setupExpandedSkillLimit ? [`    ${names.join(", ")}`] : []),
        `    ${counts.join(" · ")}${harnesses.length ? ` · ${harnesses.join(", ")}` : ""}`,
      ];
    });
}

function renderSetupAuthoredCollections(data: ContractDataForId<"skit.setup.v5">): string[] {
  return data.authoredCollections.flatMap((collection) => {
    const projections = data.projections.filter(
      (projection) => projection.collectionId === collection.collectionId,
    );
    const statuses = ["current", "modified", "missing"] as const;
    const projectionSummary = statuses.flatMap((status) => {
      const count = projections.filter((projection) => projection.status === status).length;
      return count ? [`${count} ${status}`] : [];
    });
    const names = collection.skills.map((skill) => skill.name);
    return [
      `  ${collection.namespace}/${collection.skit} · ${collection.repository}`,
      `    ${names.length} authored skill${names.length === 1 ? "" : "s"} · library ${collection.collectionId ? "present" : "missing"}${projectionSummary.length ? ` · ${projectionSummary.join(" · ")} projection${projections.length === 1 ? "" : "s"}` : ""}`,
      ...(names.length <= setupExpandedSkillLimit ? [`    ${names.join(", ")}`] : []),
      `    ${collection.origin}`,
    ];
  });
}

function renderSetupContentMatches(data: ContractDataForId<"skit.setup.v5">): string[] {
  const candidates = data.instances.filter(
    (instance) => instance.owner.kind === "unknown" && instance.locks.length === 0,
  );
  const libraryMatches = candidates.filter(
    (instance) => instance.contentIdentity.libraryMatches.length > 0,
  );
  const duplicateHashes = new Map<string, typeof candidates>();
  for (const instance of candidates) {
    const hash = instance.contentIdentity.observedHash;
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

function renderSetup(data: ContractDataForId<"skit.setup.v5">): string {
  const lines = [
    `Observed ${data.instances.length} skill instance(s) in ${data.repositories.length} repositories across ${data.machineConfig.repositoryRoots.length} configured root(s)${data.machineConfig.persisted ? " · roots saved for this machine" : ""}`,
    `Scan ${data.scan.complete ? "complete" : "incomplete"} · ${data.scan.directoriesExamined} directories examined · repository depth ${data.scan.repositorySearchDepth}`,
    "",
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
  const externalProjections = data.projections.filter(
    (projection) =>
      projection.collectionId === undefined || !authoredCollectionIds.has(projection.collectionId),
  );
  if (externalProjections.length)
    lines.push("", "Existing SKIT projections", ...renderSetupProjections(externalProjections));
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
      const recommended = action !== "blocked";
      lines.push(
        `  ${action} · ${candidates.length} skill${candidates.length === 1 ? "" : "s"}${recommended ? " · recommended" : ""}`,
      );
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
  const collections = renderSetupCollections(data);
  if (collections.length) lines.push("", "Skill collections", ...collections);
  if (data.instances.length) {
    lines.push("", "Skill instances");
    for (const item of data.instances) {
      const ownerLabel = item.owner.kind === "authored" ? "author-source" : item.owner.kind;
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

const contractPresenters: ContractPresenters = {
  [outputContracts.version.id]: (data) => data.version,
  [outputContracts.init.id]: renderAuthorInit,
  [outputContracts.authorInvocation.id]: renderAuthorInvocation,
  [outputContracts.authorDelete.id]: renderAuthorDelete,
  [outputContracts.publish.id]: (data) =>
    `Published ${data.release.version}${data.release.revision_id ? ` from ${data.release.revision_id}` : ""}`,
  [outputContracts.sync.id]: renderAuthorSync,
  [outputContracts.pin.id]: (data) => renderPin(data, true),
  [outputContracts.pinPlan.id]: (data) => renderPin(data, false),
  [outputContracts.librarySync.id]: renderLibrarySync,
  [outputContracts.libraryHistory.id]: (data) =>
    data.events.length
      ? data.events.map(renderLibraryHistoryEvent).join("\n")
      : "No Library history recorded.",
  [outputContracts.list.id]: renderLibraryList,
  [outputContracts.experimentalAuditV1Alpha4.id]: renderAuditV1Alpha4,
  [outputContracts.authorList.id]: renderAuthorList,
  [outputContracts.pull.id]: (data) =>
    data.map((item) => `${item.subject_id}: ${item.changed ? "refreshed" : "current"}`).join("\n"),
  [outputContracts.add.id]: (data) => {
    const count = data.skills.length;
    return `Added ${count} ${count === 1 ? "skill" : "skills"} to your library.`;
  },
  [outputContracts.addPreview.id]: (data) => {
    const count = data.skills.length;
    return [
      `${count} ${count === 1 ? "skill" : "skills"}`,
      "",
      ...data.skills.map((skill) => `  ${skill.name}`),
    ].join("\n");
  },
  [outputContracts.update.id]: renderUpdate,
  [outputContracts.updatePlan.id]: (data) =>
    data.length
      ? data
          .map((item) => `${item.subject_id}: ${item.changed ? "update available" : "current"}`)
          .join("\n")
      : "No device-local Sources to update",
  [outputContracts.projectionRetentionPlan.id]: (data) =>
    [
      `Would retain changed ${data.skill_name} bytes from ${data.selected_projection_id}`,
      `Observed: ${data.observed_digest}`,
      `Snapshot: ${data.snapshot_digest}`,
      `Destination: ${data.retained_path}`,
      ...data.projections.map(
        (projection) => `${projection.harness} · ${projection.path} · ${projection.agreement}`,
      ),
    ].join("\n"),
  [outputContracts.projectionRetention.id]: (data) =>
    [
      data.retained
        ? `Retained ${data.skill_name} as ${data.retained_skill_version_id}`
        : `Reconciled ${data.skill_name} using retained Version ${data.retained_skill_version_id}`,
      `Previous Version: ${data.previous_skill_version_id}`,
      ...data.projections.map(
        (projection) => `${projection.harness} · ${projection.path} · ${projection.status}`,
      ),
    ].join("\n"),
  [outputContracts.remove.id]: renderRemove,
  [outputContracts.removePlan.id]: renderRemovePlan,
  [outputContracts.enable.id]: (data) => renderSetEnabled(data, true),
  [outputContracts.enablePlan.id]: (data) => renderSetEnabled(data, false),
  [outputContracts.disable.id]: (data) => renderSetEnabled(data, true),
  [outputContracts.disablePlan.id]: (data) => renderSetEnabled(data, false),
  [outputContracts.doctor.id]: renderDoctor,
  [outputContracts.inventory.id]: (data) => renderInventory(data, data.machine),
  [outputContracts.setup.id]: renderSetup,
  [outputContracts.repositoryPolicy.id]: (data) =>
    data.action === "list"
      ? data.repositories.length
        ? data.repositories
            .map((repository) => `${repository.status} · ${repository.path}`)
            .join("\n")
        : "No repository decisions are stored for this machine."
      : `${data.action} · ${data.path}`,
  [outputContracts.authLogout.id]: (data) => `Logged out from ${data.origin}`,
  [outputContracts.authStatus.id]: renderAuthStatus,
  [outputContracts.authLogin.id]: renderAuthLogin,
  [outputContracts.registryRemote.id]: renderRegistryChange,
  [outputContracts.registryList.id]: renderRegistryList,
  [outputContracts.serverBootstrap.id]: (data) =>
    `${
      data.status === "already_complete"
        ? `Server setup was already complete at ${data.origin}`
        : `Server setup complete at ${data.origin}`
    }\nIf email verification is enabled, follow the browser result. If delivery failed, use Resend on the sign-in page.\nNext: skit auth login ${data.origin}`,
  [outputContracts.check.id]: renderCheck,
  [outputContracts.experimentalHarnessProbe.id]: renderHarnessProbe,
  [outputContracts.validate.id]: renderValidation,
  [outputContracts.securityReview.id]: renderSecurityReview,
  [outputContracts.securityAccept.id]: renderSecurityReview,
};

export function renderContract(
  id: ContractId,
  data: unknown,
  context: RenderContext,
): string | undefined {
  const presenter = contractPresenters[id];
  return presenter?.(data as never, context);
}
