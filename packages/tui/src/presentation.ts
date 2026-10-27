import type {
  AuditEntryV1Alpha4,
  AuditMcpServerV1Alpha4,
  AuditReportV1Alpha4,
  HarnessProbeResult,
} from "../../cli/src/front-end";
import {
  invocationRowSummary,
  type LibrarySkillRow,
  type PendingLibraryChange,
} from "../../cli/src/library-application/index";
import type { ListingBudget } from "@smolai/skit-core";
import { groupSkills, groupKindLabel, groupLocation, type SkillGroup } from "./skill-groups";

export type CapabilityKind = "skill" | "plugin" | "mcp-server" | "rule" | "marketplace";

export type AuditItem = {
  name: string;
  kind: CapabilityKind | "finding" | "harness";
  location: string;
  status: "clear" | "warning" | "error";
  summary: string;
  evidence: string[];
  agents: readonly string[];
  findingCount?: number;
  findingCodes?: string[];
  riskFlagCount?: number;
  provenance?: AuditEntryV1Alpha4["provenance"];
  canonicalLocation?: string;
  harnessProbe?: HarnessProbeResult;
  mcp?: Pick<AuditMcpServerV1Alpha4, "transport" | "command" | "args" | "cwd" | "url">;
};

export type SkillItem = AuditItem & {
  kind: "skill";
  provenance: NonNullable<AuditItem["provenance"]>;
};

export type SkillGroupRow = Omit<AuditItem, "kind"> & {
  kind: "skill-group";
  group: SkillGroup<SkillItem>;
};

export type LibraryRow = Omit<AuditItem, "kind"> & {
  kind: "library-skill";
  row: LibrarySkillRow;
};

export type LibraryCollectionRow = Omit<AuditItem, "kind"> & {
  kind: "library-collection";
  collectionId: string;
  source?: LibrarySkillRow["collectionSource"];
};
export type InventoryItem = AuditItem | SkillGroupRow | LibraryRow | LibraryCollectionRow;
export type SkillNavigation = { view: "groups" } | { view: "skills"; group: SkillGroup<SkillItem> };

function groupStatus(skills: AuditItem[]): AuditItem["status"] {
  if (skills.some((skill) => skill.status === "error")) return "error";
  if (skills.some((skill) => skill.status === "warning")) return "warning";
  return "clear";
}

function groupRow(group: SkillGroup<SkillItem>): SkillGroupRow {
  const { skills } = group;
  const findings = skills.reduce((total, skill) => total + (skill.findingCount ?? 0), 0);
  return {
    name: group.label,
    kind: "skill-group",
    location: groupLocation(group.identity),
    status: groupStatus(skills),
    summary: `${skills.length} discovered Skill${skills.length === 1 ? "" : "s"} in this group.`,
    evidence: [
      `skills: ${skills.length}`,
      `findings: ${findings}`,
      `harnesses: ${[...new Set(skills.flatMap((skill) => skill.agents))].join(", ") || "none"}`,
    ],
    agents: [...new Set(skills.flatMap((skill) => skill.agents))],
    findingCount: findings,
    findingCodes: [...new Set(skills.flatMap((skill) => skill.findingCodes ?? []))],
    group,
  };
}

/** Derive the passive audit inventory without a renderer, runtime, or filesystem. */
export function auditPresentation(report: AuditReportV1Alpha4) {
  interface UnknownFields {
    [key: string]: unknown;
  }

  function stringListAt(value: unknown, key: string): string[] {
    if (!value || typeof value !== "object") return [];
    const candidate = (value as UnknownFields)[key];
    return Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === "string")
      : [];
  }

  function capabilitySummary(kind: CapabilityKind, capability: AuditEntryV1Alpha4): string {
    switch (kind) {
      case "skill": {
        const capabilities =
          ("staticAudit" in capability
            ? capability.staticAudit?.inferredCapabilities
            : undefined) ?? [];
        return capabilities.length
          ? `Skill may exercise ${capabilities.join(", ")}.`
          : "Skill instructions expose no statically inferred capabilities.";
      }
      case "mcp-server":
        return `${"active" in capability && capability.active ? "Active" : "Inactive"} MCP registration in ${capability.scope} scope.`;
      case "plugin":
        return `Plugin is ${"installed" in capability && capability.installed ? "installed" : "not installed"} and ${"enabled" in capability && capability.enabled === true ? "enabled" : "enabled" in capability && capability.enabled === false ? "disabled" : "has unknown enablement"}.`;
      case "marketplace":
        return "Configured plugin marketplace or catalogue.";
      case "rule":
        return "Harness rule contributes ambient instructions and capability references.";
    }
  }

  function itemFromCapability(kind: CapabilityKind, capability: AuditEntryV1Alpha4): AuditItem {
    const related = report.findings.filter((finding) => finding.entryIds.includes(capability.id));
    const staticAudit = "staticAudit" in capability ? capability.staticAudit : undefined;
    const riskFlags = stringListAt(staticAudit, "riskFlags");
    const staticFindings =
      kind === "skill"
        ? (staticAudit?.findings ?? []).map((finding) => {
            const location = finding.location;
            return `${finding.confidence} confidence · ${location.path ?? capability.location ?? "unknown"}:${location.line}:${location.column} · ${location.excerpt}`;
          })
        : [];
    const status: AuditItem["status"] = related.some((finding) => finding.severity === "error")
      ? "error"
      : related.length
        ? "warning"
        : "clear";
    const evidence = [
      `Scope: ${{ user: "User configuration", project: "Project configuration", legacy: "Legacy configuration" }[capability.scope]}`,
      `harnesses: ${capability.harnessIds.join(", ") || "none"}`,
      `Provenance: ${{ exact: "Exact match", matched: "Inferred match", unknown: "Unknown" }[capability.provenance.confidence]} · ${capability.provenance.source ?? "source unavailable"}`,
      ...related.map((finding) => `${finding.severity}: ${finding.problem}`),
      ...staticFindings,
      ...riskFlags.map(() => "Risk indicator detected; inspect the supporting evidence."),
    ];
    return {
      name: capability.name,
      kind,
      location: capability.location ?? "unresolved",
      status,
      summary: capabilitySummary(kind, capability),
      evidence,
      agents: capability.harnessIds,
      findingCount: related.length,
      findingCodes: related.map((finding) => finding.code),
      riskFlagCount: riskFlags.length,
      provenance: capability.provenance,
      ...(capability.canonicalLocation ? { canonicalLocation: capability.canonicalLocation } : {}),
      ...(kind === "mcp-server" && "transport" in capability
        ? {
            mcp: {
              transport: capability.transport,
              ...(capability.command ? { command: capability.command } : {}),
              args: capability.args,
              ...(capability.cwd ? { cwd: capability.cwd } : {}),
              ...(capability.url ? { url: capability.url } : {}),
            },
          }
        : {}),
    };
  }

  const capabilityGroups: Array<[CapabilityKind, readonly AuditEntryV1Alpha4[]]> = [
    ["skill", report.skills],
    ["plugin", report.plugins],
    ["mcp-server", report.mcpServers],
    ["rule", report.rules],
    ["marketplace", report.marketplaces],
  ];
  const observedItems = capabilityGroups.flatMap(([kind, capabilities]) =>
    capabilities.map((capability) => itemFromCapability(kind, capability)),
  );
  const unmatchedFindings = report.findings.filter((finding) => finding.entryIds.length === 0);
  const items: AuditItem[] = [
    ...observedItems,
    ...unmatchedFindings.map((finding): AuditItem => ({
      name: finding.unresolvedSubject ?? finding.code,
      kind: "finding",
      location:
        typeof finding.details.configPath === "string"
          ? finding.details.configPath
          : "audit report",
      status: finding.severity === "error" ? "error" : "warning",
      summary: finding.code.replaceAll("-", " "),
      evidence: Object.entries(finding.details).map(
        ([key, value]) => `${key}: ${JSON.stringify(value)}`,
      ),
      agents: [],
    })),
  ];
  if (items.length === 0) {
    items.push({
      name: "No capabilities discovered",
      kind: "finding",
      location: report.roots.cwd,
      status: "warning",
      summary: "The supported skills directories contained no auditable entries.",
      evidence: [`deferred harnesses: ${report.coverage.deferredHarnessIds.join(", ") || "none"}`],
      agents: [],
    });
  }

  const capabilitiesById = new Map(
    capabilityGroups.flatMap(([, capabilities]) =>
      capabilities.map((capability) => [capability.id, capability] as const),
    ),
  );
  const harnessItems: AuditItem[] = report.harnesses
    .filter((harness) => harness.detected)
    .map((harness) => {
      const capabilities = harness.entryIds.flatMap((id) => capabilitiesById.get(id) ?? []);
      const roots = [
        ...new Set(
          capabilities
            .map((capability) => capability.location)
            .filter((path): path is string => path !== null),
        ),
      ];
      const detectionSources = roots.filter((root) => /\.(?:json|toml)$/.test(root)).slice(0, 4);
      return {
        name: harness.id,
        kind: "harness",
        location: roots[0] ?? "detected from shared capability roots",
        status: "clear",
        summary: `${harness.entryIds.length} audit entries across ${roots.length} configuration or content roots.`,
        evidence: [
          "installation probe: not run · press p",
          `audit profile: ${harness.profileId}`,
          `audit profile version: ${harness.profileVersion}`,
          ...detectionSources.map((root) => `detection source: ${root}`),
        ],
        agents: [harness.id],
      };
    });

  const skillItems = items.filter(
    (item): item is SkillItem => item.kind === "skill" && item.provenance !== undefined,
  );
  const skillGroups = groupSkills(skillItems);

  const sections = [
    {
      key: "library",
      title: "Library",
      subtitle: "Enable, disable, and choose when agents may use a skill",
      items: [] as AuditItem[],
    },

    {
      key: "harnesses",
      title: "Harnesses",
      subtitle: "Detected agent harnesses",
      items: harnessItems,
    },
    {
      key: "skills",
      title: "Skills",
      subtitle: "All discovered Skills",
      items: skillItems,
    },
    {
      key: "claude-plugins",
      title: "Claude plugins",
      subtitle: "Plugins installed for Claude Code",
      items: items.filter((item) => item.kind === "plugin" && item.agents.includes("claude-code")),
    },
    {
      key: "codex-plugins",
      title: "Codex plugins",
      subtitle: "Plugins installed for Codex",
      items: items.filter((item) => item.kind === "plugin" && item.agents.includes("codex")),
    },
    {
      key: "mcps",
      title: "MCPs",
      subtitle: "MCP registrations across all harnesses",
      items: items.filter((item) => item.kind === "mcp-server"),
    },
  ] as const;

  return { sections, skillItems, skillGroups };
}

function libraryRow(row: LibrarySkillRow): LibraryRow {
  const enabled = row.bindings.length > 0;
  return {
    name: row.name,
    kind: "library-skill",
    location: row.heading,
    status: row.invocationWarning ? "warning" : "clear",
    summary: enabled
      ? `Active in ${row.bindings.length} place${row.bindings.length === 1 ? "" : "s"}.`
      : "Not active anywhere.",
    evidence: [
      ...(enabled
        ? row.bindings.map((binding) => binding.label)
        : ["not active anywhere · press e to enable"]),
      ...(row.invocationWarning ? [row.invocationWarning] : []),
    ],
    agents: enabled ? ["every agent"] : [],
    row,
  };
}

export function libraryRows(
  rows: readonly LibrarySkillRow[],
  collectionId?: string,
): (LibraryRow | LibraryCollectionRow)[] {
  const skills = [...rows].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  if (collectionId !== undefined)
    return skills.filter((row) => row.collectionId === collectionId).map(libraryRow);
  const collections = new Map<string, LibrarySkillRow[]>();
  for (const row of skills) {
    if (row.hasCollection === false) continue;
    const members = collections.get(row.collectionId) ?? [];
    members.push(row);
    collections.set(row.collectionId, members);
  }
  const grouped = [...collections]
    .sort(([, left], [, right]) =>
      left[0]!.heading.localeCompare(right[0]!.heading, undefined, { sensitivity: "base" }),
    )
    .map(([collectionId, members]): LibraryCollectionRow => {
      const enabled = members.filter((row) => row.bindings.length > 0).length;
      return {
        kind: "library-collection",
        collectionId,
        source: members[0]?.collectionSource,
        name: members[0]!.heading,
        location: collectionId,
        status: "clear",
        summary: `${members.length} Skill${members.length === 1 ? "" : "s"} · ${enabled} enabled`,
        evidence: members.map(
          (row) => `${row.name} · ${row.bindings.length ? "enabled" : "not enabled"}`,
        ),
        agents: [],
      };
    });
  return [...grouped, ...skills.filter((row) => row.hasCollection === false).map(libraryRow)].sort(
    (left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

/** The TUI writes its own copy from structured facts rather than reusing CLI output prose. */
function changeSummary(pending: Pick<PendingLibraryChange, "facts">): string {
  return pending.facts
    .map(
      (fact) =>
        `${fact.action === "enable" ? "Enable" : "Disable"} ${fact.collectionLabel ?? fact.skills.join(", ")} for every agent (${fact.destination})`,
    )
    .join("; ");
}

function findingLabel(item: { status: AuditItem["status"]; findingCount?: number }): string {
  if (item.status === "error") return "ERROR";
  if (item.status === "warning")
    return `${item.findingCount ?? 1} WARNING${(item.findingCount ?? 1) === 1 ? "" : "S"}`;
  return "NO FINDINGS";
}

function abbreviatedHash(hash: string): string {
  return hash.length > 24 ? `${hash.slice(0, 23)}…` : hash;
}

export function harnessProbePresentation(item: AuditItem, result: HarnessProbeResult): AuditItem {
  const next = { ...item };
  next.harnessProbe = result;
  next.status =
    result.status === "failed" ? "error" : result.status === "missing" ? "warning" : "clear";
  next.summary =
    result.status === "installed"
      ? `${result.version ? `Version ${result.version}` : "Installed"}.`
      : (result.error ?? `Harness probe ${result.status}.`);
  next.evidence = [
    `probe: ${result.status}`,
    `command: ${result.command} --version`,
    ...(result.versionOutput
      ? [
          `version output: ${result.versionOutput.split("\n").find(Boolean) ?? result.versionOutput}`,
        ]
      : []),
    ...(result.error ? [`probe error: ${result.error}`] : []),
    ...next.evidence.filter((line) => !line.startsWith("installation probe:")),
  ];
  return next;
}

function statusMark(status: AuditItem["status"]): string {
  return { clear: "●", warning: "◆", error: "▲" }[status];
}
function inventoryDescription(item: InventoryItem): string {
  return item.kind === "library-collection"
    ? item.summary
    : item.kind === "library-skill"
      ? ""
      : `${(item.kind === "skill-group" ? groupKindLabel(item.group.identity) : item.kind).toUpperCase()}  ${findingLabel(item).toLowerCase()}`;
}

export interface ReceiptField {
  readonly label: string;
  readonly value: string;
  readonly status?: AuditItem["status"];
}
const field = (label: string, value: string): ReceiptField => ({ label, value });

export function detailPresentation(
  item: Exclude<InventoryItem, LibraryRow>,
  library: boolean,
  budgets: readonly ListingBudget[] = [],
) {
  const sourceNames = {
    github: "GitHub",
    git: "Git",
    registry: "SKIT registry",
    url: "URL",
    archive: "Archive",
    local: "Local",
    "authored-workspace": "Authored workspace",
    "well-known": "Well-known endpoint",
  };
  const collection = item.kind === "library-collection";
  const fields: ReceiptField[] = collection
    ? []
    : [
        field(
          "kind",
          item.kind === "skill-group" ? groupKindLabel(item.group.identity) : item.kind,
        ),
        ...(library ? [] : [{ label: "findings", value: findingLabel(item), status: item.status }]),
        field(
          item.kind === "mcp-server"
            ? "configured in"
            : item.kind === "harness"
              ? "executable"
              : "location",
          item.kind === "harness"
            ? (item.harnessProbe?.executablePath ?? "not probed · press p")
            : item.location,
        ),
        ...(library
          ? []
          : [
              field(
                item.kind === "harness" ? "harness id" : "harnesses",
                item.agents.join(", ") || "n/a",
              ),
            ]),
        ...(item.harnessProbe
          ? [
              field("probe status", item.harnessProbe.status),
              field("version", item.harnessProbe.version ?? "unknown"),
              ...(item.harnessProbe.resolvedPath
                ? [field("resolved", item.harnessProbe.resolvedPath)]
                : []),
            ]
          : []),
        ...(item.provenance
          ? [
              field("source", item.provenance.source ?? "unknown"),
              field("confidence", item.provenance.confidence),
              ...(item.provenance.collectionId
                ? [field("collection", item.provenance.collectionId)]
                : []),
              ...(item.provenance.skillId ? [field("origin", item.provenance.skillId)] : []),
              ...(item.provenance.expectedHash
                ? [field("expected hash", abbreviatedHash(item.provenance.expectedHash))]
                : []),
            ]
          : []),
        ...(item.mcp
          ? [
              field("transport", item.mcp.transport),
              ...(item.mcp.command ? [field("command", item.mcp.command)] : []),
              ...(item.mcp.args.length ? [field("arguments", item.mcp.args.join(" "))] : []),
              ...(item.mcp.cwd ? [field("working dir", item.mcp.cwd)] : []),
              ...(item.mcp.url ? [field("url", item.mcp.url)] : []),
            ]
          : []),
      ];
  return {
    source: collection
      ? item.source
        ? `${sourceNames[item.source.kind]}\n${item.source.locator}`
        : "Unknown"
      : undefined,
    fields,
    budget:
      item.kind === "harness" ? budgets.find((budget) => budget.harness === item.name) : undefined,
    evidenceTitle: collection ? "Skills" : "Evidence",
    evidence: item.evidence.map((line) => `· ${line}`).join("\n"),
    evidenceLast: collection,
    shortcuts: collection
      ? ([
          ["enter", "browse Skills"],
          ["e", "enable Collection"],
          ["d", "disable Collection"],
        ] satisfies [string, string][])
      : [],
    action:
      item.status === "clear"
        ? item.riskFlagCount
          ? "Review inferred capabilities and risk signals"
          : "No audit findings"
        : item.status === "error"
          ? item.findingCodes?.some((code) =>
              ["orphaned-projection-claim", "invalid-ownership-marker"].includes(code),
            )
            ? "Inspect custody evidence; this legacy marker does not authorize removal"
            : "Disable the installed skill and inspect its content"
          : "Inspect the warnings listed above",
  };
}

export function confirmationPresentation(
  pending: Pick<PendingLibraryChange, "facts" | "policies">,
  showSkills: boolean,
  compact: boolean,
) {
  const fields = pending.facts.flatMap((fact, index): ReceiptField[] => [
    ...(fact.collectionLabel === undefined
      ? [field("skills", fact.skills.join(", "))]
      : [
          field("collection", fact.collectionLabel),
          field("skills", String(fact.skills.length)),
          ...(showSkills ? [field("included", fact.skills.join(", "))] : []),
        ]),
    field("agents", "every agent"),
    field("applies to", fact.destination),
    ...(fact.action === "enable" && (pending.policies[index] ?? pending.policies[0])
      ? [
          field(
            "behaviour",
            invocationRowSummary((pending.policies[index] ?? pending.policies[0])!),
          ),
        ]
      : []),
    ...(fact.wholeCollection
      ? [
          field(
            "updates",
            fact.action === "enable"
              ? "includes new skills and removes deleted ones when you update"
              : "every skill is disabled",
          ),
        ]
      : []),
    field("writes", fact.writes),
  ]);
  const canShowSkills = pending.facts.some((fact) => fact.wholeCollection);
  return {
    fields,
    summary: changeSummary(pending),
    canShowSkills,
    title: pending.facts.every((fact) => fact.action === "enable")
      ? "confirm enable"
      : "confirm disable",
    help: canShowSkills
      ? `Enter apply · Esc cancel · s ${showSkills ? "hide" : "show"} Skills`
      : compact
        ? "Enter apply · Esc cancel · PgUp/PgDn scroll"
        : "enter apply   esc cancel — nothing is written until you apply",
  };
}

export type InventorySection = ReturnType<typeof auditPresentation>["sections"][number];

/** Everything the inventory renderer needs to label and populate the current navigation level. */
export function inventoryPresentation(
  section: InventorySection,
  input: {
    readonly skills: readonly LibrarySkillRow[];
    readonly collectionId?: string;
    readonly skillGroups: readonly SkillGroup<SkillItem>[];
    readonly skillNavigation: SkillNavigation;
    readonly findings: number;
    readonly libraryError?: string;
  },
) {
  const { skills, collectionId, skillGroups, skillNavigation, findings } = input;
  const collectionHeading = skills.find((row) => row.collectionId === collectionId)?.heading;
  const skillGroup = skillNavigation.view === "skills" ? skillNavigation.group : undefined;
  const items: InventoryItem[] =
    section.key === "library"
      ? libraryRows(skills, collectionId)
      : section.key === "skills"
        ? skillGroup
          ? skillGroup.skills
          : skillGroups.map(groupRow)
        : [...section.items];
  return {
    items,
    options: items.map((item, index) => ({
      name: section.key === "library" ? item.name : `${statusMark(item.status)} ${item.name}`,
      description: inventoryDescription(item),
      value: `${item.kind}:${index}`,
    })),
    subtitle:
      section.key === "library"
        ? collectionId === undefined
          ? `${items.length} Collections · ${skills.length} Skills`
          : `${collectionHeading ?? "Collection"} · ${items.length} Skills`
        : `${section.key === "skills" && skillGroup ? skillGroup.label : section.subtitle} · ${items.length} entries · ${findings} findings`,
    listTitle:
      section.key === "library"
        ? collectionId === undefined
          ? "collections"
          : (collectionHeading ?? "collection")
        : section.key === "skills" && skillGroup
          ? `skills / ${skillGroup.label} · ${items.length}`
          : `${section.key} · ${items.length}`,
    showDescription: !(section.key === "library" && collectionId !== undefined),
    emptyMessage:
      section.key === "library"
        ? input.libraryError
          ? `Library unavailable\n${input.libraryError}`
          : "Your Library is empty. Add a source with skit add <source>."
        : `No ${section.title.toLowerCase()} detected.`,
  };
}
