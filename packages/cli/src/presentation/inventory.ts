import { homedir } from "node:os";
import { basename, dirname, sep } from "node:path";
import type { HarnessName, LibraryInventory } from "@smolai/skit-core";
import { harnessLabel } from "../harness/catalog.js";
import { conditionHeadline, projectionStatusLabel } from "./condition-language.js";
import type { MachineInventoryResult } from "../workflows/library/machine-inventory-contract.js";

type MachineInstance = MachineInventoryResult["machine"]["instances"][number];

const ownerLines = (owner: MachineInstance["owner"]): readonly string[] => {
  switch (owner.kind) {
    case "skills-sh":
      return ["Installed by: skills.sh", `Source: ${owner.source}`];
    case "skit":
      return owner.membership.kind === "retained"
        ? [
            `Collection: ${owner.membership.displayName}`,
            ...(owner.membership.source ? [`Source: ${owner.membership.source}`] : []),
          ]
        : [`Collection: not in this Library (${owner.membership.collectionId})`];
    case "harness":
      return [
        `Installed by: ${harnessLabel(owner.harness)}${owner.bundled ? " (bundled)" : ""}`,
        `Source: ${owner.source}`,
      ];
    case "repository":
      return ["Installed by: repository"];
    case "authored":
      return [`Authored Collection: ${owner.collectionRef}`];
    case "invalid-marker":
      return ["Installed by: invalid SKIT ownership marker"];
    case "unknown":
      return ["Installed by: unknown"];
  }
};

const ownerLabel = (owner: MachineInstance["owner"]): string => {
  switch (owner.kind) {
    case "skit":
      return "Managed by SKIT";
    case "invalid-marker":
      return "Invalid SKIT ownership marker";
    case "authored":
    case "skills-sh":
    case "harness":
    case "repository":
    case "unknown":
      return "Not managed by SKIT";
  }
};

const gitLabel = (
  status: MachineInventoryResult["machine"]["instances"][number]["git"]["status"],
): string => {
  switch (status) {
    case "committed":
      return "Tracked and clean";
    case "modified":
      return "Tracked with local changes";
    case "staged":
      return "Changes staged";
    case "untracked":
      return "Not tracked";
    case "ignored":
      return "Ignored by Git";
    case "mixed":
      return "Mixed Git state";
    case "outside-git":
      return "Outside Git";
    case "unavailable":
      return "Git state unavailable";
  }
};

const compactPath = (path: string): string => {
  const home = homedir();
  return path === home
    ? "~"
    : path.startsWith(`${home}${sep}`)
      ? `~${path.slice(home.length)}`
      : path;
};

const libraryRelationshipLabel = (identity: MachineInstance["contentIdentity"]): string => {
  if (identity.status === "unhashable") return "Library bytes: could not compare";
  if (identity.libraryMatches.length === 0) return "Library bytes: no match";
  return `Library bytes: ${identity.status === "ambiguous" ? "ambiguous match" : "exact match"}`;
};

const displayPath = (path: string, repository?: string): string =>
  repository !== undefined && path.startsWith(`${repository}${sep}`)
    ? path.slice(repository.length + 1)
    : compactPath(path);

const instancePaths = (instance: MachineInstance, repository?: string): readonly string[] =>
  [...new Set([instance.path, ...instance.aliases])]
    .map((path) => displayPath(path, repository))
    .sort();

const instanceFacts = (instance: MachineInstance, repository?: string): readonly string[] => {
  const locks = instance.locks
    .map((lock) => {
      const path =
        repository !== undefined && lock.lockPath.startsWith(`${repository}${sep}`)
          ? lock.lockPath.slice(repository.length + 1)
          : compactPath(lock.lockPath);
      return `Lock: ${path} · ${lock.content}`;
    })
    .sort();
  return [
    ...ownerLines(instance.owner),
    `Git: ${gitLabel(instance.git.status)}`,
    ...(instance.owner.kind === "skit" && instance.contentIdentity.status === "exact"
      ? []
      : [libraryRelationshipLabel(instance.contentIdentity)]),
    ...locks,
  ];
};

const skillCountLabel = (count: number): string => `${count} Skill${count === 1 ? "" : "s"}`;

const explicitCollectionKey = (instance: MachineInstance): string | undefined => {
  switch (instance.owner.kind) {
    case "skit":
      return `skit:${instance.owner.membership.collectionId}`;
    case "authored":
      return `authored:${instance.owner.collectionId ?? instance.owner.collectionRef}`;
    case "skills-sh":
      return `skills-sh:${instance.owner.source}`;
    case "invalid-marker":
    case "harness":
    case "repository":
    case "unknown":
      return undefined;
  }
};

const pathPattern = (path: string, skillName: string): string =>
  basename(path) === skillName ? `${dirname(path)}${sep}<skill>` : path;

const wrappedNames = (names: readonly string[], indent: string): readonly string[] => {
  const width = 96;
  const lines: string[] = [];
  let line = indent;
  for (const name of names) {
    const addition = line === indent ? name : `, ${name}`;
    if (line !== indent && line.length + addition.length > width) {
      lines.push(line);
      line = `${indent}${name}`;
    } else line += addition;
  }
  if (line !== indent) lines.push(line);
  return lines;
};

export function renderMachineSkills(machine: MachineInventoryResult["machine"]): string {
  const names = new Set(machine.instances.map((instance) => instance.name));
  const lines = [
    `Inventory · ${names.size} Skill${names.size === 1 ? "" : "s"} · ${machine.instances.length} instance${machine.instances.length === 1 ? "" : "s"}`,
  ];
  const locations = new Map<string, typeof machine.instances>();
  for (const instance of machine.instances) {
    const location = instance.git.repository ?? "Global and standalone";
    locations.set(location, [...(locations.get(location) ?? []), instance]);
  }
  for (const [location, instances] of locations) {
    const repository = location === "Global and standalone" ? undefined : location;
    const locationNames = new Set(instances.map((instance) => instance.name));
    const scopes = new Set(instances.map((instance) => instance.scope));
    const locationLabel =
      location !== "Global and standalone"
        ? compactPath(location)
        : scopes.size === 1 && scopes.has("global")
          ? "Global"
          : scopes.size === 1 && scopes.has("standalone")
            ? "Standalone"
            : location;
    lines.push(
      "",
      `${locationLabel} · ${locationNames.size} Skill${locationNames.size === 1 ? "" : "s"}${instances.length === locationNames.size ? "" : ` · ${instances.length} instances`}`,
    );
    const custodyGroups = new Map<string, typeof instances>();
    for (const instance of instances) {
      const custody = ownerLabel(instance.owner);
      custodyGroups.set(custody, [...(custodyGroups.get(custody) ?? []), instance]);
    }
    for (const [custody, custodyInstances] of custodyGroups) {
      const bySkill = new Map<string, { name: string; instances: typeof custodyInstances }>();
      for (const instance of custodyInstances) {
        const key = `${explicitCollectionKey(instance) ?? "standalone"}\0${instance.name}`;
        const skill = bySkill.get(key) ?? { name: instance.name, instances: [] };
        bySkill.set(key, { ...skill, instances: [...skill.instances, instance] });
      }
      const instanceCount = custodyInstances.length;
      const skillCount = bySkill.size;
      lines.push(
        "",
        `  ${custody} · ${skillCount} Skill${skillCount === 1 ? "" : "s"}${instanceCount === skillCount ? "" : ` · ${instanceCount} instances`}`,
      );
      const cohorts = new Map<
        string,
        { names: string[]; facts: readonly string[]; patterns: readonly string[] }
      >();
      for (const { name, instances: skillInstances } of bySkill.values()) {
        const collectionRefs = [
          ...new Set(
            skillInstances
              .map(explicitCollectionKey)
              .filter((reference): reference is string => reference !== undefined),
          ),
        ];
        const facts = [
          ...new Set(skillInstances.flatMap((instance) => instanceFacts(instance, repository))),
        ].sort();
        const patterns = [
          ...new Set(
            skillInstances.flatMap((instance) =>
              instancePaths(instance, repository).map((path) => pathPattern(path, name)),
            ),
          ),
        ].sort();
        const collectionKey = collectionRefs.length === 1 ? collectionRefs[0] : `skill:${name}`;
        const key = JSON.stringify([collectionKey, facts, patterns]);
        const cohort = cohorts.get(key) ?? { names: [], facts, patterns };
        cohort.names.push(name);
        cohorts.set(key, cohort);
      }
      for (const cohort of [...cohorts.values()].sort((left, right) =>
        left.names[0]!.localeCompare(right.names[0]!),
      )) {
        cohort.names.sort();
        lines.push("", `    ${skillCountLabel(cohort.names.length)}`);
        if (cohort.patterns.length)
          lines.push("      Locations:", ...cohort.patterns.map((pattern) => `        ${pattern}`));
        lines.push(
          ...cohort.facts.map((fact) => `      ${fact}`),
          "",
          ...wrappedNames(cohort.names, "      "),
        );
      }
    }
  }
  if (!machine.instances.length) lines.push("", "  No Skill instances observed.");
  return lines.join("\n");
}

const renderScanScope = (machine: MachineInventoryResult["machine"]): string => {
  const lines = [
    "Scan scope",
    `  Status: ${machine.scan.complete ? "complete" : "incomplete"}`,
    `  Directories examined: ${machine.scan.directoriesExamined}`,
    `  Repository depth: ${machine.scan.repositorySearchDepth}`,
    "  Repository roots:",
    ...(machine.repositoryRoots.length
      ? machine.repositoryRoots.map((root) => `    ${compactPath(root)}`)
      : ["    none configured"]),
  ];
  const ignoredRepositories = machine.repositoryDecisions.filter(
    (repository) => repository.status === "ignored",
  );
  if (ignoredRepositories.length)
    lines.push(
      "  Ignored repositories:",
      ...ignoredRepositories.map((repository) => `    ${compactPath(repository.path)}`),
    );
  if (machine.scan.missingRepositories?.length)
    lines.push(
      "  Missing watched repositories:",
      ...machine.scan.missingRepositories.map((path) => `    ${compactPath(path)}`),
    );
  return lines.join("\n");
};

const inventoryFindings = (state: LibraryInventory): string[] => {
  const lines: string[] = [];
  if (state.custodyIssues?.length) {
    lines.push(`Custody issues · ${state.custodyIssues.length}`);
    for (const issue of state.custodyIssues)
      lines.push(
        `  ${conditionHeadline(issue.code, "Local custody issue")}`,
        `    Path: ${compactPath(issue.path)}`,
      );
    lines.push("  Run skit doctor for details.");
  }
  if (state.scanIssues?.length) {
    if (lines.length) lines.push("");
    lines.push(`Scan issues · ${state.scanIssues.length}`);
    for (const issue of state.scanIssues) {
      if (issue.code === "DANGLING_SYMLINK") {
        lines.push(
          "",
          "  Dangling link",
          `    Harness: ${harnessLabel(issue.harness)}`,
          `    Link: ${compactPath(issue.path)}`,
          `    Missing target: ${compactPath(issue.target)}`,
        );
        continue;
      }
      lines.push(
        "",
        `  ${issue.code === "MISSING_ROOT" ? "Missing root" : "Unreadable root"}`,
        `    Harness: ${harnessLabel(issue.harness)}`,
        `    Path: ${compactPath(issue.path)}`,
      );
    }
  }
  return lines;
};

export function renderInventory(
  state: LibraryInventory,
  machine?: MachineInventoryResult["machine"],
): string {
  const groups = new Map<string, string[]>();
  const add = (harnesses: readonly HarnessName[], path: string, row: string) => {
    const heading = `${harnesses.map(harnessLabel).join(", ")} · ${dirname(path)}`;
    const rows = groups.get(heading) ?? [];
    rows.push(row);
    groups.set(heading, rows);
  };
  const managed = new Map<
    string,
    { name: string; statuses: Set<string>; harnesses: Set<HarnessName> }
  >();
  for (const projection of state.projections) {
    const path = projection.path;
    const skill = state.skills.find((candidate) => candidate.skill_id === projection.skill_id);
    if (skill === undefined) continue;
    const row = managed.get(path) ?? {
      name: skill.name,
      statuses: new Set<string>(),
      harnesses: new Set<HarnessName>(),
    };
    row.harnesses.add(projection.harness);
    row.statuses.add(projection.status);
    managed.set(path, row);
  }
  for (const [path, row] of managed)
    add(
      [...row.harnesses].sort(),
      path,
      `  ${row.name} · managed · ${[...row.statuses].sort().map(projectionStatusLabel).join(", ")}\n    ${path}`,
    );
  for (const item of state.unmanaged) {
    const paths = item.paths ?? [item.path];
    add(
      item.harnesses ?? [item.harness],
      item.path,
      `  ${basename(item.path)} · unmanaged\n${paths.map((path) => `    ${path}`).join("\n")}${paths.length > 1 ? "\n    Shared physical copy" : ""}`,
    );
  }
  const lines: string[] = [];
  for (const [heading, rows] of groups) lines.push(heading, ...rows, "");
  if (!groups.size) lines.push("No skill copies observed.", "");
  const findings = inventoryFindings(state);
  if (findings.length) lines.push("", ...findings);
  const library = lines.join("\n").trimEnd();
  if (!machine) return library;
  const summary = `Library projections · ${managed.size} managed · ${state.unmanaged.length} unmanaged`;
  return [
    renderMachineSkills(machine),
    summary,
    ...(findings.length ? [findings.join("\n")] : []),
    renderScanScope(machine),
  ].join("\n\n");
}
