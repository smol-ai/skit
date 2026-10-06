#!/usr/bin/env bun

// PROTOTYPE: five audit inventory projections plus a command palette.

import {
  BoxRenderable,
  fg,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  TextRenderable,
  type KeyEvent,
} from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { Effect, FileSystem, Layer } from "effect";
import {
  LibraryActor,
  libraryStoreLayer,
  skitLayer,
  errorMessage,
  auditLocalCapabilitiesV1Alpha4Effect,
  probeHarnessEffect,
  openLibrarySession,
  readLibrarySkillContent,
  refreshLibrarySession,
  proposeLibraryEnable,
  proposeLibraryCollectionChange,
  proposeLibraryDisable,
  proposeLibraryInvocation,
  confirmLibraryChange,
  cancelLibraryChange,
  DESTINATION_QUESTION,
  destinationLabel,
  invocationChoices,
  invocationBriefing,
  invocationEligibleBindings,
  invocationRowSummary,
  scopeChoices,
  type AuditEntryV1Alpha4,
  type AuditMcpServerV1Alpha4,
  type HarnessProbeResult,
  type ProbeableHarness,
  type LibraryActionOutcome,
  type LibraryBindingRow,
  type LibrarySkillRow,
  type PendingLibraryChange,
  type Scope,
  type InvocationOption,
} from "../../cli/src/front-end";
import { createLibraryHost } from "./library-host";
import { createRenderer, writeFrame } from "./snapshot";
import { copySelectedText, isCopySelectionKey } from "./selection-copy";
import {
  chip,
  ink,
  keybar,
  kv,
  listColors,
  panelColors,
  panelTitle,
  receipt,
  sep,
  surface,
  tone,
} from "./theme";
import {
  groupForSkill,
  groupKindLabel,
  groupLocation,
  groupSkills,
  type SkillGroup,
} from "./skill-groups";

type CapabilityKind = "skill" | "plugin" | "mcp-server" | "rule" | "marketplace";

type AuditItem = {
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

type SkillItem = AuditItem & {
  kind: "skill";
  provenance: NonNullable<AuditItem["provenance"]>;
};

type SkillGroupRow = Omit<AuditItem, "kind"> & {
  kind: "skill-group";
  group: SkillGroup<SkillItem>;
};

type LibraryRow = Omit<AuditItem, "kind"> & {
  kind: "library-skill";
  row: LibrarySkillRow;
};

type LibraryCollectionRow = Omit<AuditItem, "kind"> & {
  kind: "library-collection";
  collectionId: string;
  source?: LibrarySkillRow["collectionSource"];
};
type InventoryItem = AuditItem | SkillGroupRow | LibraryRow | LibraryCollectionRow;
let libraryCollectionId: string | undefined;

type SkillNavigation = { view: "groups" } | { view: "skills"; group: SkillGroup<SkillItem> };

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

// One host runtime and serialized state transitions for the writable Library view.
const libraryHome = resolve(
  flag("--skit-home") ?? process.env.SKIT_HOME ?? join(homedir(), ".skit"),
);
const libraryConfiguration = {
  home: homedir(),
  configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  statePath: join(libraryHome, "state.json"),
  variantsPath: join(libraryHome, "variants"),
  overrides: { codex: flag("--codex-root"), claude: flag("--claude-root") },
  now: () => new Date().toISOString(),
};
const libraryHost = createLibraryHost(
  libraryStoreLayer({ home: libraryHome }).pipe(
    Layer.provideMerge(skitLayer),
    Layer.provideMerge(Layer.succeed(LibraryActor)("tui")),
  ),
  openLibrarySession(),
);
let libraryOpenError: string | undefined;
// Every workflow the TUI runs enters the runtime through the host, the audit included.
const report = await libraryHost.run(
  auditLocalCapabilitiesV1Alpha4Effect({
    home: flag("--home"),
    cwd: flag("--cwd") ?? resolve(import.meta.dir, "../../.."),
    probes: [],
  }),
);
const transitionLibrary = libraryHost.transition;
try {
  await libraryHost.open();
} catch (error) {
  libraryOpenError = errorMessage(error);
}

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
        ("staticAudit" in capability ? capability.staticAudit?.inferredCapabilities : undefined) ??
        [];
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
      typeof finding.details.configPath === "string" ? finding.details.configPath : "audit report",
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
    summary: "The supported Harness roots contained no auditable entries.",
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
let skillNavigation: SkillNavigation = { view: "groups" };

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

const snapshotPath = process.env.SKIT_TUI_SNAPSHOT;
const { renderer, test } = await createRenderer(
  snapshotPath,
  process.env.SKIT_TUI_SNAPSHOT_SIZE,
).catch(async (error: unknown) => {
  await libraryHost.dispose();
  throw error;
});
renderer.once("destroy", () => {
  void libraryHost.dispose();
});

const requestedView = flag("--view");
const requestedVariant = sections.findIndex((section) => section.key === requestedView);
let variant = requestedVariant < 0 ? 0 : requestedVariant;
const requestedItem = flag("--item");
const requestedSkill = skillItems.find((item) => item.name === requestedItem);
if (sections[variant]?.key === "skills" && requestedSkill) {
  const group = groupForSkill(skillGroups, requestedSkill);
  if (group) skillNavigation = { view: "skills", group };
}
const requestedItemIndex =
  sections[variant]?.key === "skills" && skillNavigation.view === "groups"
    ? skillGroups.findIndex((group) => group.label === requestedItem)
    : (skillNavigation.view === "skills"
        ? skillNavigation.group.skills
        : sections[variant]?.items
      )?.findIndex((item) => item.name === requestedItem);
let selectedItem =
  requestedItemIndex !== undefined && requestedItemIndex >= 0 ? requestedItemIndex : 0;
if (sections[variant]?.key === "library" && requestedItem) {
  const rows = libraryRows();
  const collectionIndex = rows.findIndex((row) => row.name === requestedItem);
  if (collectionIndex >= 0) selectedItem = collectionIndex;
  else {
    const skill = libraryHost.state?.skills.find((row) => row.name === requestedItem);
    if (skill) {
      libraryCollectionId = skill.collectionId;
      selectedItem = libraryRows().findIndex(
        (row) => row.kind === "library-skill" && row.row.skillVersionId === skill.skillVersionId,
      );
    }
  }
}
let currentView: BoxRenderable | null = null;
let paletteView: BoxRenderable | null = null;
let paletteSelect: SelectRenderable | null = null;
let documentView: BoxRenderable | null = null;
let documentScroll: ScrollBoxRenderable | null = null;
let pendingSkillPreview: Promise<void> | undefined;

function box(
  id: string,
  options: ConstructorParameters<typeof BoxRenderable>[1] = {},
): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    backgroundColor: "transparent",
    ...options,
  });
}

function text(
  id: string,
  content: string,
  options: Omit<ConstructorParameters<typeof TextRenderable>[1], "content"> = {},
): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    content,
    fg: ink.DEFAULT,
    ...options,
  });
}

function statusColor(status: AuditItem["status"]): string {
  return {
    clear: tone.success,
    warning: tone.warning,
    error: tone.danger,
  }[status];
}

function statusMark(status: AuditItem["status"]): string {
  return { clear: "●", warning: "◆", error: "▲" }[status];
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

let narrowDetails = false;
let detailsScroll: ScrollBoxRenderable | null = null;
const isNarrow = () => renderer.width < 80;
const isCompact = () => renderer.width < 110;
function modalWidth() {
  return isCompact()
    ? { left: 1, width: Math.max(1, renderer.width - 2) }
    : { left: "16%" as const, width: "68%" as const };
}
function fitLabel(value: string, width: number): string {
  const chars = Array.from(value);
  return chars.length <= width ? value : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function header(title: string, subtitle: string): BoxRenderable {
  const result = box(`header-${variant}`, {
    width: "100%",
    height: 3,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  });
  result.add(
    new TextRenderable(renderer, {
      id: `title-${variant}`,
      content: isCompact()
        ? `SKIT / ${title}`
        : new StyledText([
            fg(ink.strong)("SKIT"),
            sep(),
            fg(ink.muted)(sections[variant]?.key === "library" ? "Skills" : "Audit"),
            sep(),
            fg(tone.accent)(title),
          ]),
      marginLeft: 1,
    }),
  );
  if (!isCompact())
    result.add(text(`subtitle-${variant}`, subtitle, { fg: ink.faint, marginRight: 1 }));
  return result;
}

function footer(label: string): BoxRenderable {
  const result = box(`footer-${variant}`, {
    width: "100%",
    height: 2,
    paddingLeft: 1,
    alignItems: "center",
  });
  result.add(
    new TextRenderable(renderer, {
      id: `footer-text-${variant}`,
      content: keybar(
        isCompact()
          ? [
              ["enter", "open"],
              ["esc", "back"],
              ...(sections[variant]?.key === "library" ? [["e/d", ""] as [string, string]] : []),
              ["^P", "menu"],
            ]
          : [
              ["↑↓", "browse"],
              ...(sections[variant]!.key === "harnesses"
                ? [["p", "probe"] as [string, string], ["P", "probe all"] as [string, string]]
                : []),
              ...(sections[variant]!.key === "library"
                ? [
                    ...(libraryCollectionId === undefined
                      ? [
                          ["enter", "open collection"] as [string, string],
                          ["e", "enable"] as [string, string],
                          ["d", "disable"] as [string, string],
                        ]
                      : [
                          ["esc", "collections"] as [string, string],
                          ["e", "enable"] as [string, string],
                          ["d", "disable"] as [string, string],
                          ["i", "when used"] as [string, string],
                        ]),
                    ["r", "refresh"] as [string, string],
                  ]
                : []),
              ...(sections[variant]!.key === "skills"
                ? skillNavigation.view === "groups"
                  ? [["enter", "open"] as [string, string]]
                  : [
                      ["enter", "read"] as [string, string],
                      ["esc", "collections"] as [string, string],
                    ]
                : []),
              ["[ ]", "view"],
              ["1–6", "jump"],
              ["^P", "commands"],
              ["q", "quit"],
            ],
      ),
    }),
  );
  if (!isCompact())
    result.add(text(`footer-label-${variant}`, label, { fg: ink.faint, marginLeft: 1 }));
  return result;
}

function libraryRow(row: LibrarySkillRow): LibraryRow {
  const enabled = row.bindings.length > 0;
  return {
    name: row.name,
    kind: "library-skill",
    location: row.heading,
    status: "clear",
    summary: enabled
      ? `Active in ${row.bindings.length} place${row.bindings.length === 1 ? "" : "s"}.`
      : "Not active anywhere.",
    evidence: enabled
      ? row.bindings.map((binding) => binding.label)
      : ["not active anywhere · press e to enable"],
    agents: enabled ? ["every agent"] : [],
    row,
  };
}

function libraryRows(): (LibraryRow | LibraryCollectionRow)[] {
  const skills = [...(libraryHost.state?.skills ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  if (libraryCollectionId !== undefined)
    return skills.filter((row) => row.collectionId === libraryCollectionId).map(libraryRow);
  const collections = new Map<string, LibrarySkillRow[]>();
  for (const row of skills) {
    const members = collections.get(row.collectionId) ?? [];
    members.push(row);
    collections.set(row.collectionId, members);
  }
  return [...collections]
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
}

function currentSectionItems(): InventoryItem[] {
  const section = sections[variant]!;
  if (section.key === "library") return libraryRows();
  if (section.key !== "skills") return [...section.items];
  return skillNavigation.view === "groups"
    ? skillGroups.map(groupRow)
    : skillNavigation.group.skills;
}

function selectedLibraryRow(): LibrarySkillRow | undefined {
  if (sections[variant]?.key !== "library") return;
  const item = currentSectionItems()[selectedItem];
  return item?.kind === "library-skill" ? item.row : undefined;
}

function confirmationCollection(pending: PendingLibraryChange, index: number): string | undefined {
  const operation = pending.operations[index];
  if (!operation?.all) return;
  return (
    libraryHost.state?.skills.find((row) => row.collectionId === operation.query)?.heading ??
    operation.query
  );
}

/** The TUI writes its own copy from structured facts rather than reusing CLI output prose. */
function changeSummary(pending: PendingLibraryChange): string {
  return pending.facts
    .map(
      (fact, index) =>
        `${fact.action === "enable" ? "Enable" : "Disable"} ${confirmationCollection(pending, index) ?? fact.skills.join(", ")} for every agent (${fact.destination})`,
    )
    .join("; ");
}

function inventoryView(): BoxRenderable {
  const section = sections[variant]!;
  const sectionItems = currentSectionItems();
  selectedItem = Math.min(selectedItem, Math.max(0, sectionItems.length - 1));
  const root = box("inventory-root", {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: surface.canvas,
  });
  root.add(
    header(
      section.title,
      section.key === "library"
        ? libraryCollectionId === undefined
          ? `${sectionItems.length} Collections · ${libraryHost.state?.skills.length ?? 0} Skills`
          : `${libraryHost.state?.skills.find((row) => row.collectionId === libraryCollectionId)?.heading ?? "Collection"} · ${sectionItems.length} Skills`
        : section.key === "skills" && skillNavigation.view === "skills"
          ? `${skillNavigation.group.label} · ${sectionItems.length} entries · ${report.summary.findings} findings`
          : `${section.subtitle} · ${sectionItems.length} entries · ${report.summary.findings} findings`,
    ),
  );

  const body = box("inventory-body", {
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    padding: 1,
    backgroundColor: "transparent",
  });
  const listWidth = isNarrow()
    ? Math.max(1, renderer.width - 2)
    : isCompact()
      ? 30
      : Math.min(52, Math.floor(renderer.width * 0.35));
  const listPanel = box("inventory-list-panel", {
    width: listWidth,
    minWidth: listWidth,
    maxWidth: listWidth,
    flexShrink: 0,
    height: "100%",
    border: true,
    ...panelColors(true),
    title: panelTitle(
      fitLabel(
        section.key === "library"
          ? libraryCollectionId === undefined
            ? "collections"
            : (libraryHost.state?.skills.find((row) => row.collectionId === libraryCollectionId)
                ?.heading ?? "collection")
          : section.key === "skills" && skillNavigation.view === "skills"
            ? `skills / ${skillNavigation.group.label} · ${sectionItems.length}`
            : `${section.key} · ${sectionItems.length}`,
        listWidth - 4,
      ),
      section.key === "library" && libraryCollectionId !== undefined,
    ),
  });
  const select = new SelectRenderable(renderer, {
    id: "inventory-select",
    width: "100%",
    height: "100%",
    selectedIndex: selectedItem,
    showDescription: !(section.key === "library" && libraryCollectionId !== undefined),
    itemSpacing: 0,
    options: sectionItems.map((item, index) => ({
      name: fitLabel(
        section.key === "library" ? item.name : `${statusMark(item.status)} ${item.name}`,
        listWidth - 6,
      ),
      description:
        item.kind === "library-collection"
          ? item.summary
          : item.kind === "library-skill"
            ? ""
            : `${(item.kind === "skill-group" ? groupKindLabel(item.group.identity) : item.kind).toUpperCase()}  ${findingLabel(item).toLowerCase()}`,
      value: `${item.kind}:${index}`,
    })),
    textColor: ink.DEFAULT,
    descriptionColor: ink.faint,
    ...listColors(true),
    focusedBackgroundColor: "transparent",
    focusedTextColor: ink.DEFAULT,
    wrapSelection: true,
  });
  select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    selectedItem = index;
    const item = sectionItems[index];
    if (detailsScroll && item) populateDetails(detailsScroll, item);
    else if (!isNarrow() || narrowDetails) render();
  });
  select.on(SelectRenderableEvents.ITEM_SELECTED, () => openSelectedSkill());
  listPanel.add(select);
  if (!(isNarrow() && narrowDetails)) select.focus();

  const item = sectionItems[selectedItem];
  if (item && isNarrow() && !narrowDetails) {
    body.add(listPanel);
    root.add(body);
    root.add(footer(section.title));
    return root;
  }
  if (!item) {
    const empty = box("inventory-empty", {
      flexGrow: 1,
      minWidth: 0,
      height: "100%",
      border: true,
      ...panelColors(false),
      title: panelTitle("details"),
      padding: 2,
    });
    empty.add(
      text(
        "inventory-empty-text",
        section.key === "library"
          ? libraryOpenError
            ? `Library unavailable\n${libraryOpenError}`
            : "Your Library is empty. Add a source with skit add <source>."
          : `No ${section.title.toLowerCase()} detected.`,
        {
          fg: ink.faint,
        },
      ),
    );
    if (!isNarrow()) body.add(listPanel);
    body.add(empty);
    root.add(body);
    root.add(footer(`${variant + 1} / ${section.title.toLowerCase()}`));
    return root;
  }
  const details = new ScrollBoxRenderable(renderer, {
    id: "inventory-details",
    scrollY: true,
    scrollX: false,
    verticalScrollbarOptions: { visible: true },
    horizontalScrollbarOptions: { visible: false },
    contentOptions: { flexDirection: "column", gap: 1, flexShrink: 0 },
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    border: true,
    ...panelColors(false),
    title:
      item.kind === "library-collection" || item.kind === "library-skill"
        ? ` ${item.name} `
        : panelTitle(section.key === "library" ? "details" : "evidence"),
    titleColor: section.key === "library" ? tone.accent : ink.faint,
    padding: isCompact() ? 1 : 2,
  });
  detailsScroll = details;
  if (isNarrow()) details.focus();
  populateDetails(details, item);

  if (!isNarrow()) body.add(listPanel);
  body.add(details);
  root.add(body);
  root.add(footer(`${variant + 1} / ${section.title.toLowerCase()}`));
  return root;
}

let detailRevision = 0;
function populateDetails(details: ScrollBoxRenderable, item: InventoryItem): void {
  const section = sections[variant]!;
  const revision = ++detailRevision;
  details.title =
    item.kind === "library-collection" || item.kind === "library-skill"
      ? ` ${item.name} `
      : panelTitle(section.key === "library" ? "details" : "evidence");
  for (const child of details.content.getChildren()) {
    details.remove(child);
    child.destroyRecursively();
  }
  details.scrollTo(0);
  if (item.kind === "library-skill") {
    const content = text("library-skill-content", "Loading…", { width: "100%" });
    details.add(content);
    pendingSkillPreview = libraryHost.run(readLibrarySkillContent(item.row.skillVersionId)).then(
      (value) => {
        if (detailsScroll === details && revision === detailRevision) content.content = value;
      },
      (error: unknown) => {
        if (detailsScroll === details && revision === detailRevision)
          content.content = `Unable to read retained Skill\n${errorMessage(error)}`;
      },
    );
    return;
  }
  if (item.kind === "library-collection") {
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
    details.add(text("collection-source-title", "Source", { fg: tone.accentSoft }));
    details.add(
      text(
        "collection-source",
        item.source ? `${sourceNames[item.source.kind]}\n${item.source.locator}` : "Unknown",
      ),
    );
  } else {
    details.add(text("detail-name", item.name, { fg: statusColor(item.status) }));
    details.add(
      new TextRenderable(renderer, {
        id: "detail-receipt",
        content: receipt([
          kv(
            "kind",
            item.kind === "skill-group" ? groupKindLabel(item.group.identity) : item.kind,
            14,
          ),
          ...(section.key === "library"
            ? []
            : [kv("findings", chip(findingLabel(item), statusColor(item.status)), 14)]),
          kv(
            item.kind === "mcp-server"
              ? "configured in"
              : item.kind === "harness"
                ? "executable"
                : "location",
            item.kind === "harness"
              ? (item.harnessProbe?.executablePath ?? "not probed · press p")
              : item.location,
            14,
          ),
          ...(section.key === "library"
            ? []
            : [
                kv(
                  item.kind === "harness" ? "harness id" : "harnesses",
                  item.agents.join(", ") || "n/a",
                  14,
                ),
              ]),
          ...(item.harnessProbe
            ? [
                kv("probe status", item.harnessProbe.status, 14),
                kv("version", item.harnessProbe.version ?? "unknown", 14),
                ...(item.harnessProbe.resolvedPath
                  ? [kv("resolved", item.harnessProbe.resolvedPath, 14)]
                  : []),
              ]
            : []),
          ...(item.provenance
            ? [
                kv("source", item.provenance.source ?? "unknown", 14),
                kv("confidence", item.provenance.confidence, 14),
                ...(item.provenance.collectionId
                  ? [kv("collection", item.provenance.collectionId, 14)]
                  : []),
                ...(item.provenance.skillId ? [kv("origin", item.provenance.skillId, 14)] : []),
                ...(item.provenance.expectedHash
                  ? [kv("expected hash", abbreviatedHash(item.provenance.expectedHash), 14)]
                  : []),
              ]
            : []),
          ...(item.mcp
            ? [
                kv("transport", item.mcp.transport, 14),
                ...(item.mcp.command ? [kv("command", item.mcp.command, 14)] : []),
                ...(item.mcp.args.length ? [kv("arguments", item.mcp.args.join(" "), 14)] : []),
                ...(item.mcp.cwd ? [kv("working dir", item.mcp.cwd, 14)] : []),
                ...(item.mcp.url ? [kv("url", item.mcp.url, 14)] : []),
              ]
            : []),
        ]),
      }),
    );
  }
  details.add(text("detail-summary", item.summary));
  const addEvidence = () => {
    details.add(
      text("detail-evidence-title", item.kind === "library-collection" ? "Skills" : "Evidence", {
        fg: tone.accentSoft,
      }),
    );
    details.add(text("detail-evidence", item.evidence.map((line) => `· ${line}`).join("\n")));
  };
  if (item.kind !== "library-collection") addEvidence();
  details.add(text("detail-action-title", "Actions", { fg: tone.accentSoft }));
  const shortcuts: [string, string][] =
    item.kind === "library-collection"
      ? [
          ["enter", "browse Skills"],
          ["e", "enable Collection"],
          ["d", "disable Collection"],
        ]
      : [];
  if (shortcuts.length) {
    const actions = box("detail-actions", { flexDirection: "column", gap: 0, flexShrink: 0 });
    for (const [index, shortcut] of shortcuts.entries()) {
      actions.add(
        new TextRenderable(renderer, {
          id: `detail-action-${index}`,
          content: keybar([shortcut]),
        }),
      );
    }
    details.add(actions);
  } else {
    details.add(
      text(
        "detail-action",
        item.status === "clear"
          ? item.riskFlagCount
            ? "Review inferred capabilities and risk signals"
            : "No audit findings"
          : item.status === "error"
            ? item.findingCodes?.some((code) =>
                ["orphaned-projection-claim", "invalid-ownership-marker"].includes(code),
              )
              ? "Inspect custody evidence; this legacy marker does not authorize removal"
              : "Disable projection and inspect content"
            : "Inspect the warnings listed above",
      ),
    );
  }

  if (item.kind === "library-collection") addEvidence();
}

function render(): void {
  if (currentView) {
    renderer.root.remove(currentView);
    currentView.destroyRecursively();
  }
  currentView = inventoryView();
  renderer.root.add(currentView);
}

function switchVariant(next: number): void {
  variant = (next + sections.length) % sections.length;
  skillNavigation = { view: "groups" };
  libraryCollectionId = undefined;
  narrowDetails = false;
  selectedItem = 0;
  render();
}

const keymap = createDefaultOpenTuiKeymap(renderer);
const viewCommandNames = [
  "view.library",
  "view.harnesses",
  "view.skills",
  "view.claude-plugins",
  "view.codex-plugins",
  "view.mcps",
] as const;

const paletteCommands = [
  {
    name: "view.harnesses",
    title: "Open Harnesses",
    description: "Browse agent harnesses detected on this system",
    shortcut: "2",
    keywords: "agents adapters detected",
    run: () => switchVariant(1),
  },
  {
    name: "view.skills",
    title: "Open Skills",
    description: "Browse all discovered Skills",
    shortcut: "3",
    keywords: "instructions capabilities audit",
    run: () => switchVariant(2),
  },
  {
    name: "view.claude-plugins",
    title: "Open Claude plugins",
    description: "Browse plugins installed for Claude Code",
    shortcut: "4",
    keywords: "claude code extensions",
    run: () => switchVariant(3),
  },
  {
    name: "view.codex-plugins",
    title: "Open Codex plugins",
    description: "Browse plugins installed for Codex",
    shortcut: "5",
    keywords: "codex extensions",
    run: () => switchVariant(4),
  },
  {
    name: "view.mcps",
    title: "Open MCPs",
    description: "Browse MCP registrations across all harnesses",
    shortcut: "6",
    keywords: "mcp server transport tools",
    run: () => switchVariant(5),
  },
  {
    name: "view.library",
    title: "Open Library",
    description: "Enable, disable, and choose when agents may use Library skills",
    shortcut: "1",
    keywords: "library enable disable invocation binding projection",
    run: () => switchVariant(0),
  },
  {
    name: "app.quit",
    title: "Quit SKIT audit",
    description: "Close the interactive audit",
    shortcut: "Q",
    keywords: "exit close",
    run: async () => {
      await libraryHost.dispose();
      renderer.destroy();
    },
  },
] as const;

keymap.registerLayer({ commands: paletteCommands });

function commandField(
  command: (typeof paletteCommands)[number],
  field: "title" | "description" | "shortcut",
): string {
  return command[field];
}

function closePalette(): void {
  if (!paletteView) return;
  renderer.root.remove(paletteView);
  paletteView.destroyRecursively();
  paletteView = null;
  paletteSelect = null;
  render();
}

function runPaletteCommand(name: string): void {
  closePalette();
  keymap.runCommand(name);
}

function closeDocument(): void {
  if (!documentView) return;
  renderer.root.remove(documentView);
  documentView.destroyRecursively();
  documentView = null;
  documentScroll = null;
  render();
}

function openSelectedSkill(): void {
  if (
    documentView ||
    (!isNarrow() && !(sections[variant]?.key === "library" || sections[variant]?.key === "skills"))
  )
    return;
  const item = currentSectionItems()[selectedItem];
  if (item?.kind === "library-collection") {
    libraryCollectionId = item.collectionId;
    narrowDetails = false;
    selectedItem = 0;
    render();
    return;
  }
  if (item?.kind === "skill-group") {
    skillNavigation = { view: "skills", group: item.group };
    selectedItem = 0;
    render();
    return;
  }
  if (item && isNarrow() && !narrowDetails) {
    narrowDetails = true;
    render();
    return;
  }
  if (!item || item.kind !== "skill") return;
  const location = item.location;
  const name = item.name;
  void libraryHost
    .run(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(location)).pipe(
        Effect.catch((error) => Effect.succeed(`Unable to read ${location}\n\n${error.message}`)),
      ),
    )
    .then((content) => {
      if (documentView) return;
      showDocument(name, location, content);
    });
}

function showDocument(name: string, location: string, content: string): void {
  const overlay = box("skill-document", {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    border: true,
    backgroundColor: surface.canvas,
    ...panelColors(true),
    title: panelTitle(`SKILL.md · ${name}`),
    flexDirection: "column",
    padding: 1,
  });
  const pathLine = text("skill-document-path", location, { fg: ink.faint, height: 2 });
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "skill-document-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
    focusable: true,
    viewportCulling: true,
    verticalScrollbarOptions: { visible: true },
  });
  scroll.add(
    text("skill-document-content", content, {
      width: "100%",
    }),
  );
  overlay.add(pathLine);
  overlay.add(scroll);
  overlay.add(
    text("skill-document-help", "↑↓/PgUp/PgDn scroll   Home/End jump   Esc close", {
      fg: ink.faint,
      height: 1,
    }),
  );
  documentView = overlay;
  documentScroll = scroll;
  renderer.root.add(overlay);
  scroll.focus();
}

function isProbeableHarness(value: string): value is ProbeableHarness {
  return value === "codex" || value === "claude-code" || value === "opencode";
}

/** Harnesses with a probe already running, so a repeated key cannot start a second one. */
const probing = new Set<string>();

async function runHarnessProbe(item: AuditItem): Promise<void> {
  if (item.kind !== "harness" || !isProbeableHarness(item.name)) return;
  if (probing.has(item.name)) return;
  probing.add(item.name);
  let result: HarnessProbeResult;
  try {
    result = await libraryHost.run(probeHarnessEffect(item.name));
  } catch (error) {
    item.status = "error";
    item.summary = `Harness probe failed: ${errorMessage(error)}`;
    return;
  } finally {
    probing.delete(item.name);
  }
  item.harnessProbe = result;
  item.status =
    result.status === "failed" ? "error" : result.status === "missing" ? "warning" : "clear";
  item.summary =
    result.status === "installed"
      ? `${result.version ? `Version ${result.version}` : "Installed"}.`
      : (result.error ?? `Harness probe ${result.status}.`);
  item.evidence = [
    `probe: ${result.status}`,
    `command: ${result.command} --version`,
    ...(result.versionOutput
      ? [
          `version output: ${result.versionOutput.split("\n").find(Boolean) ?? result.versionOutput}`,
        ]
      : []),
    ...(result.error ? [`probe error: ${result.error}`] : []),
    ...item.evidence.filter((line) => !line.startsWith("installation probe:")),
  ];
}

function probeSelectedHarness(all: boolean): void {
  if (sections[variant]?.key !== "harnesses") return;
  const targets = all
    ? sections[variant].items
    : sections[variant].items.slice(selectedItem, selectedItem + 1);
  // Probing is asynchronous now; render when it finishes rather than blocking the key handler.
  void (async () => {
    for (const item of targets) await runHarnessProbe(item);
    render();
  })();
}

const ALL_BINDINGS = "all";

interface ChooserOption {
  value: string;
  label: string;
  hint?: string;
}

interface Chooser {
  title: string;
  /** What the operator needs to know before deciding, shown above the options. */
  briefing?: string;
  options: readonly ChooserOption[];
  choose: (value: string) => void | Promise<void>;
}

let chooserView: BoxRenderable | null = null;
let chooserSelect: SelectRenderable | null = null;
let confirmView: BoxRenderable | null = null;
let confirmScroll: ScrollBoxRenderable | null = null;
let confirmShowSkills = false;

function closeChooser(): void {
  if (!chooserView) return;
  renderer.root.remove(chooserView);
  chooserView.destroyRecursively();
  chooserView = null;
  chooserSelect = null;
  render();
}

function openChooser(chooser: Chooser): void {
  closeChooser();
  const overlay = box("library-chooser", {
    position: "absolute",
    ...modalWidth(),
    top: "15%",
    height: "70%",
    zIndex: 110,
    border: true,
    backgroundColor: surface.canvas,
    ...panelColors(true),
    title: panelTitle(chooser.title),
    flexDirection: "column",
    padding: 1,
    gap: 1,
  });
  if (chooser.briefing)
    overlay.add(
      new TextRenderable(renderer, {
        id: "library-chooser-briefing",
        content: chooser.briefing,
        fg: ink.faint,
      }),
    );
  const select = new SelectRenderable(renderer, {
    id: "library-chooser-results",
    width: "100%",
    flexGrow: 1,
    textColor: ink.DEFAULT,
    descriptionColor: ink.faint,
    ...listColors(true),
    focusedBackgroundColor: "transparent",
    showScrollIndicator: true,
    wrapSelection: true,
    options: chooser.options.map((option) => ({
      name: option.label,
      description: option.hint ?? "",
      value: option.value,
    })),
  });
  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
    if (typeof option?.value !== "string") return;
    const value = option.value;
    closeChooser();
    void chooser.choose(value);
  });
  overlay.add(select);
  overlay.add(
    text("library-chooser-help", "↑↓ browse   enter select   esc cancel", { fg: ink.faint }),
  );
  chooserView = overlay;
  chooserSelect = select;
  renderer.root.add(overlay);
  select.focus();
}

function closeConfirm(): void {
  if (!confirmView) return;
  renderer.root.remove(confirmView);
  confirmView.destroyRecursively();
  confirmView = null;
  confirmScroll = null;
  render();
}

/** Every Library write passes through this preview before it is applied. */
function openConfirm(): void {
  const pending = libraryHost.state?.pending;
  if (!pending) return;
  closeConfirm();
  const enabling = pending.facts.every((fact) => fact.action === "enable");
  const overlay = box("library-confirm", {
    position: "absolute",
    ...modalWidth(),
    top: "15%",
    height: "70%",
    zIndex: 120,
    border: true,
    backgroundColor: surface.canvas,
    ...panelColors(true),
    title: panelTitle(enabling ? "confirm enable" : "confirm disable"),
    flexDirection: "column",
    padding: 1,
    gap: 1,
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "library-confirm-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
    contentOptions: { gap: 1, flexShrink: 0 },
  });
  scroll.add(text("library-confirm-summary", changeSummary(pending), { fg: ink.strong }));
  scroll.add(
    new TextRenderable(renderer, {
      id: "library-confirm-receipt",
      content: receipt(
        pending.facts.flatMap((fact, index) => [
          ...(confirmationCollection(pending, index) === undefined
            ? [kv("skills", fact.skills.join(", "), 14)]
            : [
                kv("collection", confirmationCollection(pending, index)!, 14),
                kv("skills", String(fact.skills.length), 14),
                ...(confirmShowSkills ? [kv("included", fact.skills.join(", "), 14)] : []),
              ]),
          kv("agents", "every agent", 14),
          kv("applies to", fact.destination, 14),
          ...(fact.action === "enable" && (pending.policies[index] ?? pending.policies[0])
            ? [
                kv(
                  "behaviour",
                  invocationRowSummary((pending.policies[index] ?? pending.policies[0])!),
                  14,
                ),
              ]
            : []),
          ...(fact.wholeCollection
            ? [
                kv(
                  "updates",
                  fact.action === "enable"
                    ? "includes new skills and removes deleted ones when you update"
                    : "every skill is disabled",
                  14,
                ),
              ]
            : []),
          kv("writes", fact.writes, 14),
        ]),
      ),
    }),
  );
  overlay.add(scroll);
  overlay.add(
    text(
      "library-confirm-help",
      pending.operations.some((operation) => operation.all)
        ? `Enter apply · Esc cancel · s ${confirmShowSkills ? "hide" : "show"} Skills`
        : isCompact()
          ? "Enter apply · Esc cancel · PgUp/PgDn scroll"
          : "enter apply   esc cancel — nothing is written until you apply",
      {
        fg: ink.faint,
        flexShrink: 0,
      },
    ),
  );
  confirmView = overlay;
  confirmScroll = scroll;
  renderer.root.add(overlay);
  scroll.focus();
}

function afterProposal(outcome: LibraryActionOutcome | undefined): void {
  if (!outcome) return;
  render();
  if (outcome.kind === "preview") {
    confirmShowSkills = false;
    openConfirm();
  }
}

function chooseScopeThen(next: (scope: Scope) => void | Promise<void>): void {
  const choices = scopeChoices(resolve(process.cwd()));
  if (choices.length === 1) {
    void next(choices[0]!.scope);
    return;
  }
  openChooser({
    title: DESTINATION_QUESTION,
    options: choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.hint ? { hint: choice.hint } : {}),
    })),
    choose: (value) => next(choices.find((choice) => choice.value === value)!.scope),
  });
}

function bindingChooserOptions(bindings: readonly LibraryBindingRow[]): ChooserOption[] {
  return bindings.map((binding, index) => ({
    value: String(index),
    label: destinationLabel(binding.scope),
    ...(binding.policy ? { hint: invocationRowSummary(binding.policy) } : {}),
  }));
}

function selectedLibraryCollection(): LibraryCollectionRow | undefined {
  if (sections[variant]?.key !== "library") return;
  const item = currentSectionItems()[selectedItem];
  return item?.kind === "library-collection" ? item : undefined;
}

function startEnable(): void {
  const collection = selectedLibraryCollection();
  if (collection && libraryHost.state) {
    chooseScopeThen(async (scope) =>
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryCollectionChange(
            state,
            libraryConfiguration,
            collection.collectionId,
            true,
            [scope],
          ),
        ),
      ),
    );
    return;
  }
  const row = selectedLibraryRow();
  if (!row || !libraryHost.state) return;
  openChooser({
    title: "What would you like to enable?",
    options: [
      {
        value: "collection",
        label: `Enable whole collection · ${row.heading}`,
        hint: "Include new skills and remove deleted ones when you update",
      },
      { value: "skill", label: `Enable ${row.name}`, hint: "Only this Skill" },
    ],
    choose: (value) =>
      chooseScopeThen(async (scope) =>
        afterProposal(
          await transitionLibrary((state) =>
            value === "collection"
              ? proposeLibraryCollectionChange(
                  state,
                  libraryConfiguration,
                  row.collectionId,
                  true,
                  [scope],
                )
              : proposeLibraryEnable(state, libraryConfiguration, row, { scope }),
          ),
        ),
      ),
  });
}

function startDisable(): void {
  const collection = selectedLibraryCollection();
  if (collection && libraryHost.state) {
    const byDestination = new Map(
      libraryHost.state.skills
        .filter((row) => row.collectionId === collection.collectionId)
        .flatMap((row) => row.bindings)
        .map((binding) => [destinationLabel(binding.scope), binding.scope]),
    );
    const scopes = [...byDestination.values()];
    if (!scopes.length) return;
    const disable = async (selectedScopes: readonly Scope[]) =>
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryCollectionChange(
            state,
            libraryConfiguration,
            collection.collectionId,
            false,
            selectedScopes,
          ),
        ),
      );
    if (scopes.length === 1) void disable(scopes);
    else
      openChooser({
        title: DESTINATION_QUESTION,
        options: [
          { value: ALL_BINDINGS, label: "All shown" },
          ...scopes.map((scope, index) => ({
            value: String(index),
            label: destinationLabel(scope),
          })),
        ],
        choose: (value) => disable(value === ALL_BINDINGS ? scopes : [scopes[Number(value)]!]),
      });
    return;
  }
  const row = selectedLibraryRow();
  if (!row || !libraryHost.state) return;
  openChooser({
    title: "What would you like to disable?",
    options: [
      {
        value: "collection",
        label: `Disable whole collection · ${row.heading}`,
        hint: "Disable every skill in this collection",
      },
      ...(row.bindings.length ? [{ value: "skill", label: `Disable ${row.name}` }] : []),
    ],
    choose: (value) => {
      if (value === "collection") {
        chooseScopeThen(async (scope) =>
          afterProposal(
            await transitionLibrary((state) =>
              proposeLibraryCollectionChange(state, libraryConfiguration, row.collectionId, false, [
                scope,
              ]),
            ),
          ),
        );
        return;
      }
      const disable = async (bindings: readonly LibraryBindingRow[]) =>
        afterProposal(
          await transitionLibrary((state) =>
            proposeLibraryDisable(state, libraryConfiguration, row, bindings),
          ),
        );
      if (row.bindings.length === 1) void disable(row.bindings);
      else
        openChooser({
          title: DESTINATION_QUESTION,
          options: [
            { value: ALL_BINDINGS, label: "All shown" },
            ...bindingChooserOptions(row.bindings),
          ],
          choose: (chosen) =>
            disable(chosen === ALL_BINDINGS ? row.bindings : [row.bindings[Number(chosen)]!]),
        });
    },
  });
}

function startInvocation(): void {
  const row = selectedLibraryRow();
  const session = libraryHost.state;
  if (!row || !session) return;
  const eligible = invocationEligibleBindings(row);
  if (!eligible.length) return;
  const choosePolicy = (binding: LibraryBindingRow) => {
    if (!binding.policy) return;
    openChooser({
      title: binding.policy.question,
      briefing: invocationBriefing(binding.policy),
      options: invocationChoices(binding).map((choice) => ({
        value: choice.value,
        label: choice.label,
        ...(choice.hint ? { hint: choice.hint } : {}),
      })),
      choose: async (value) =>
        afterProposal(
          await transitionLibrary((state) =>
            proposeLibraryInvocation(
              state,
              libraryConfiguration,
              row,
              binding,
              value as InvocationOption,
            ),
          ),
        ),
    });
  };
  if (eligible.length === 1) choosePolicy(eligible[0]!);
  else
    openChooser({
      title: DESTINATION_QUESTION,
      options: bindingChooserOptions(eligible),
      choose: (value) => choosePolicy(eligible[Number(value)]!),
    });
}

async function applyPending(): Promise<void> {
  closeConfirm();
  if (!libraryHost.state) return;
  await transitionLibrary((state) => confirmLibraryChange(state, libraryConfiguration));
  render();
}

async function cancelPending(): Promise<void> {
  closeConfirm();
  if (libraryHost.state)
    await transitionLibrary((state) => Effect.succeed(cancelLibraryChange(state)));
  render();
}

async function refreshLibrary(): Promise<void> {
  if (!libraryHost.state) return;
  await transitionLibrary((state) => refreshLibrarySession(state));
  render();
}

function openPalette(): void {
  if (paletteView) return;

  const overlay = box("command-palette", {
    position: "absolute",
    ...modalWidth(),
    top: "15%",
    height: "70%",
    zIndex: 100,
    border: true,
    backgroundColor: surface.canvas,
    ...panelColors(true),
    title: panelTitle("command palette"),
    flexDirection: "column",
    padding: 1,
    gap: 1,
  });
  const input = new InputRenderable(renderer, {
    id: "command-palette-input",
    width: "100%",
    placeholder: "Search commands…",
    textColor: ink.strong,
    focusedBackgroundColor: surface.hairline,
    cursorColor: tone.accent,
  });
  const select = new SelectRenderable(renderer, {
    id: "command-palette-results",
    width: "100%",
    flexGrow: 1,
    textColor: ink.DEFAULT,
    descriptionColor: ink.faint,
    ...listColors(true),
    focusedBackgroundColor: "transparent",
    showScrollIndicator: true,
    wrapSelection: true,
  });
  const updateResults = (query: string): void => {
    const commands = keymap.getCommands({
      visibility: "registered",
      search: query,
      searchIn: ["name", "title", "description", "keywords"],
    }) as (typeof paletteCommands)[number][];
    select.options = commands.map((command) => ({
      name: commandField(command, "title"),
      description: `${commandField(command, "description")}${command.shortcut ? `  ·  ${command.shortcut}` : ""}`,
      value: command.name,
    }));
    select.setSelectedIndex(0);
  };

  input.on(InputRenderableEvents.INPUT, (value: string) => updateResults(value));
  input.on(InputRenderableEvents.ENTER, () => select.selectCurrent());
  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
    if (typeof option?.value === "string") runPaletteCommand(option.value);
  });
  updateResults("");
  overlay.add(input);
  overlay.add(select);
  overlay.add(text("command-palette-help", "↑↓ browse   enter run   esc close", { fg: ink.faint }));
  paletteView = overlay;
  paletteSelect = select;
  renderer.root.add(overlay);
  input.focus();
}

function handleGlobalKey(key: KeyEvent): void {
  if (key.ctrl && key.name === "c") {
    key.preventDefault();
    keymap.runCommand("app.quit", { event: key });
    return;
  }
  if (isCopySelectionKey(key, renderer.hasSelection)) {
    key.preventDefault();
    copySelectedText(renderer);
    return;
  }
  if (documentView) {
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      closeDocument();
    } else if (key.name === "home") {
      key.preventDefault();
      documentScroll?.scrollTo(0);
    } else if (key.name === "end") {
      key.preventDefault();
      documentScroll?.scrollTo(documentScroll.scrollHeight);
    }
    return;
  }
  if (confirmView) {
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      cancelPending();
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      key.stopPropagation();
      void applyPending();
    } else if (
      key.name === "s" &&
      libraryHost.state?.pending?.operations.some((operation) => operation.all)
    ) {
      key.preventDefault();
      key.stopPropagation();
      confirmShowSkills = !confirmShowSkills;
      openConfirm();
    } else if (["pageup", "pagedown", "home", "end"].includes(key.name)) {
      key.preventDefault();
      if (key.name === "home") confirmScroll?.scrollTo(0);
      else if (key.name === "end") confirmScroll?.scrollTo(confirmScroll.scrollHeight);
      else confirmScroll?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
    }
    return;
  }
  if (chooserView) {
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      closeChooser();
      void cancelPending();
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "up") chooserSelect?.moveUp();
      else chooserSelect?.moveDown();
    }
    return;
  }
  if (paletteView) {
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      closePalette();
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "up") paletteSelect?.moveUp();
      else paletteSelect?.moveDown();
    }
    return;
  }
  if (isNarrow() && narrowDetails && key.name === "escape") {
    key.preventDefault();
    key.stopPropagation();
    narrowDetails = false;
    render();
  } else if (detailsScroll !== null && ["pageup", "pagedown", "home", "end"].includes(key.name)) {
    key.preventDefault();
    const scroll = detailsScroll;
    if (key.name === "home") scroll?.scrollTo(0);
    else if (key.name === "end") scroll?.scrollTo(scroll.scrollHeight);
    else scroll?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
  } else if (isNarrow() && narrowDetails && ["return", "enter"].includes(key.name)) {
    key.preventDefault();
    openSelectedSkill();
  } else if (
    key.name === "escape" &&
    sections[variant]?.key === "skills" &&
    skillNavigation.view === "skills"
  ) {
    key.preventDefault();
    skillNavigation = { view: "groups" };
    selectedItem = 0;
    render();
  } else if (
    key.name === "escape" &&
    sections[variant]?.key === "library" &&
    libraryCollectionId !== undefined
  ) {
    const previous = libraryCollectionId;
    libraryCollectionId = undefined;
    selectedItem = libraryRows().findIndex(
      (row) => row.kind === "library-collection" && row.collectionId === previous,
    );
    key.preventDefault();
    render();
  } else if (key.ctrl && key.name === "p") {
    key.preventDefault();
    key.stopPropagation();
    openPalette();
  } else if (key.name === "q") {
    key.preventDefault();
    keymap.runCommand("app.quit", { event: key });
  } else if (key.name === "p" && sections[variant]?.key === "harnesses") {
    key.preventDefault();
    probeSelectedHarness(key.shift);
  } else if (sections[variant]?.key === "library" && ["e", "d", "i", "r"].includes(key.name)) {
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "e") startEnable();
    else if (key.name === "d") startDisable();
    else if (key.name === "i") startInvocation();
    else void refreshLibrary();
  } else if (["1", "2", "3", "4", "5", "6"].includes(key.name)) {
    keymap.runCommand(viewCommandNames[Number(key.name) - 1]!, { event: key });
  } else if (key.name === "]" || key.name === "right") {
    keymap.runCommand(viewCommandNames[(variant + 1) % sections.length]!, { event: key });
  } else if (key.name === "[" || key.name === "left") {
    keymap.runCommand(viewCommandNames[(variant - 1 + sections.length) % sections.length]!, {
      event: key,
    });
  }
}

renderer.keyInput.on("keypress", handleGlobalKey);
renderer.on("resize", () => {
  const scrollTop = detailsScroll?.scrollTop;
  render();
  if (scrollTop !== undefined) detailsScroll?.scrollTo(scrollTop);
  for (const modal of [chooserView, confirmView, paletteView]) {
    if (!modal) continue;
    const dimensions = modalWidth();
    modal.left = dimensions.left;
    modal.width = dimensions.width;
  }
  if (documentView) documentScroll?.focus();
  else if (paletteView) {
    // Their input retains focus when the underlying list is rerendered.
    renderer.root.findDescendantById("command-palette-input")?.focus();
  } else if (chooserView) chooserSelect?.focus();
  else if (confirmView) confirmScroll?.focus();
});

if (process.env.SKIT_TUI_SNAPSHOT_DETAILS === "1") narrowDetails = true;
render();

if (process.env.SKIT_TUI_SNAPSHOT_HARNESS_PROBE === "1") probeSelectedHarness(true);
if (process.env.SKIT_TUI_SNAPSHOT_PALETTE === "1") openPalette();
if (process.env.SKIT_TUI_SNAPSHOT_DOCUMENT === "1") {
  if (sections[variant]?.key === "skills" && skillNavigation.view === "groups") {
    skillNavigation = { view: "skills", group: skillGroups[0]! };
    selectedItem = 0;
    render();
  }
  openSelectedSkill();
}

if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY && sections[variant]?.key === "library") {
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "enable") startEnable();
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "disable") startDisable();
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "confirm") {
    const collection = selectedLibraryCollection();
    if (collection && libraryHost.state)
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryCollectionChange(
            state,
            libraryConfiguration,
            collection.collectionId,
            true,
            [{ kind: "global" }],
          ),
        ),
      );
    const row = selectedLibraryRow();
    if (row && libraryHost.state)
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryEnable(state, libraryConfiguration, row, { scope: { kind: "global" } }),
        ),
      );
  }
}

if (test && snapshotPath) {
  await test.flush();
  if (process.env.SKIT_TUI_SNAPSHOT_KEYS) {
    for (const key of process.env.SKIT_TUI_SNAPSHOT_KEYS.split(",")) {
      const leavingDetails = key === "ESCAPE" && isNarrow() && narrowDetails;
      await test.mockInput.pressKey(key);
      if (leavingDetails) await test.waitFor(() => !narrowDetails);
      await test.flush();
    }
  }
  if (process.env.SKIT_TUI_SNAPSHOT_RESIZE) {
    const [width, height] = process.env.SKIT_TUI_SNAPSHOT_RESIZE.split("x").map(Number);
    if (width && height) test.resize(width, height);
  }
  await pendingSkillPreview;
  await writeFrame(test, snapshotPath);
  await libraryHost.dispose();
  renderer.destroy();
}
