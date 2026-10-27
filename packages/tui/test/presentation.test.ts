import { resolveDeclaredInvocation } from "@smolai/skit-core";
import { Result } from "effect";
import { expect, test } from "vitest";
import type { AuditReportV1Alpha4, HarnessProbeResult } from "../../cli/src/front-end";
import type {
  LibrarySkillRow,
  PendingLibraryChange,
} from "../../cli/src/library-application/index";
import {
  auditPresentation,
  confirmationPresentation,
  detailPresentation,
  harnessProbePresentation,
  inventoryPresentation,
  libraryRows,
  type AuditItem,
} from "../src/presentation";

const entry = {
  id: "review",
  name: "review",
  harnessIds: ["codex"],
  scope: "user",
  location: "/skills/review/SKILL.md",
  provenance: { confidence: "exact", evidence: "fixture", source: "Fixture" },
} as const;
const report: AuditReportV1Alpha4 = {
  schemaVersion: "v1alpha4",
  generatedAt: "2026-10-16T00:00:00Z",
  roots: { home: "/home", cwd: "/work" },
  harnesses: [
    {
      id: "codex",
      detected: true,
      profileId: "codex",
      profileVersion: "1",
      frontmatterContracts: [],
      skillMetadataContracts: [],
      documentation: [],
      entryIds: ["review", "mcp"],
    },
    {
      id: "claude-code",
      detected: false,
      profileId: "claude",
      profileVersion: "1",
      frontmatterContracts: [],
      skillMetadataContracts: [],
      documentation: [],
      entryIds: [],
    },
  ],
  skills: [{ ...entry, role: "native", aliases: [] }],
  plugins: [
    { ...entry, id: "codex-plugin", name: "codex-plugin", installed: true, enabled: false },
    {
      ...entry,
      id: "claude-plugin",
      name: "claude-plugin",
      harnessIds: ["claude-code"],
      installed: true,
      enabled: true,
    },
  ],
  mcpServers: [
    {
      ...entry,
      id: "mcp",
      name: "mcp",
      location: "/home/.codex/config.toml",
      transport: "stdio",
      active: true,
      enabled: true,
      command: "fixture",
      args: ["--stdio"],
    },
  ],
  rules: [],
  marketplaces: [],
  findings: [
    {
      id: "warning",
      severity: "warning",
      code: "warning",
      entryIds: ["review"],
      unresolvedSubject: null,
      problem: "Review warning",
      locations: [],
      details: {},
    },
    {
      id: "error",
      severity: "error",
      code: "orphaned-projection-claim",
      entryIds: ["review"],
      unresolvedSubject: null,
      problem: "Custody error",
      locations: [],
      details: {},
    },
    {
      id: "other",
      severity: "error",
      code: "other",
      entryIds: ["mcp"],
      unresolvedSubject: null,
      problem: "MCP error",
      locations: [],
      details: {},
    },
  ],
  probes: [],
  coverage: { deferredHarnessIds: [] },
  summary: {
    harnesses: 1,
    skills: 1,
    plugins: 2,
    mcpServers: 1,
    rules: 0,
    marketplaces: 0,
    findings: 3,
  },
};

const skill = (
  name: string,
  collectionId: string,
  heading: string,
  enabled = false,
): LibrarySkillRow => ({
  name,
  collectionId,
  heading,
  skillId: `${collectionId}-skill-${name}`,
  skillVersionId: `${collectionId}-${name}`,
  authorInvocation: resolveDeclaredInvocation({ name, path: "." }, () => undefined).pipe(
    Result.mapError((error) => error.message),
  ),
  source: null,
  revision: null,
  acquired_at: null,
  source_updated_at: null,
  collectionSource: { kind: "local", locator: `/sources/${collectionId}` },
  bindings: enabled
    ? [{ scope: { kind: "global" }, invocation: "declared", label: "All projects" }]
    : [],
});

test("audit rows associate findings with their entries and partition plugins by harness", () => {
  const model = auditPresentation(report);
  expect(model.skillItems[0]).toMatchObject({
    status: "error",
    findingCount: 2,
    findingCodes: ["warning", "orphaned-projection-claim"],
  });
  expect(model.skillItems[0]!.evidence).toContain("error: Custody error");
  expect(model.skillItems[0]!.evidence).not.toContain("error: MCP error");
  expect(
    model.sections
      .find((section) => section.key === "claude-plugins")!
      .items.map((item) => item.name),
  ).toEqual(["claude-plugin"]);
  expect(
    model.sections
      .find((section) => section.key === "codex-plugins")!
      .items.map((item) => item.name),
  ).toEqual(["codex-plugin"]);
  expect(
    model.sections.find((section) => section.key === "harnesses")!.items.map((item) => item.name),
  ).toEqual(["codex"]);
  const groups = inventoryPresentation(model.sections[2], {
    skills: [],
    skillGroups: model.skillGroups,
    skillNavigation: { view: "groups" },
    findings: 3,
  });
  expect(groups.items[0]).toMatchObject({ status: "error", findingCount: 2 });
  expect(report.skills[0]).not.toHaveProperty("findingCount");
});

test("details retain MCP launch evidence and ownership-specific action guidance", () => {
  const model = auditPresentation(report);
  const mcp = model.sections.find((section) => section.key === "mcps")!.items[0]!;
  const details = detailPresentation(mcp, false);
  expect(details.fields).toEqual(
    expect.arrayContaining([
      { label: "transport", value: "stdio" },
      { label: "command", value: "fixture" },
      { label: "arguments", value: "--stdio" },
      { label: "configured in", value: "/home/.codex/config.toml" },
    ]),
  );
  expect(detailPresentation(model.skillItems[0]!, false).action).toContain(
    "does not authorize removal",
  );
  const risky: AuditItem = { ...model.skillItems[0]!, status: "clear", riskFlagCount: 1 };
  expect(detailPresentation(risky, false).action).toContain("risk signals");
});

test("Library rows group collections, keep standalone Skills, and never sort the session in place", () => {
  const skills = [
    skill("zulu", "tools", "Tools"),
    { ...skill("solo", "solo", "solo"), hasCollection: false },
    skill("alpha", "tools", "Tools", true),
  ];
  const rows = libraryRows(skills);
  expect(rows.map((row) => [row.kind, row.name])).toEqual([
    ["library-skill", "solo"],
    ["library-collection", "Tools"],
  ]);
  expect(skills.map((row) => row.name)).toEqual(["zulu", "solo", "alpha"]);
  expect(libraryRows(skills, "tools").map((row) => row.name)).toEqual(["alpha", "zulu"]);
  const collection = rows[1]!;
  expect(collection.evidence).toEqual(["alpha · enabled", "zulu · not enabled"]);
  if (collection.kind !== "library-collection") throw new Error("Expected a collection");
  const details = detailPresentation(collection, true);
  expect(details.source).toContain("/sources/tools");
  expect(details.shortcuts.map(([key]) => key)).toEqual(["enter", "e", "d"]);
  expect(details.evidenceLast).toBe(true);
});

test("navigation derives rows and descriptions together for collections, members, and Skill groups", () => {
  const audit = auditPresentation(report);
  const skills = [skill("review", "tools", "Tools")];
  const input = {
    skills,
    skillGroups: audit.skillGroups,
    skillNavigation: { view: "groups" } as const,
    findings: 3,
  };
  const library = audit.sections[0];
  const collections = inventoryPresentation(library, input);
  expect(collections.items.map((item) => item.kind)).toEqual(["library-collection"]);
  expect(collections.showDescription).toBe(true);
  const members = inventoryPresentation(library, { ...input, collectionId: "tools" });
  expect(members.items.map((item) => item.kind)).toEqual(["library-skill"]);
  expect(members.showDescription).toBe(false);
  expect(members.listTitle).toBe("Tools");
  const group = audit.skillGroups[0]!;
  expect(
    inventoryPresentation(audit.sections[2], {
      ...input,
      skillNavigation: { view: "skills", group },
    }).items,
  ).toEqual(group.skills);
  expect(
    inventoryPresentation(library, { ...input, skills: [], libraryError: "Unreadable" })
      .emptyMessage,
  ).toContain("Unreadable");
});

test("confirmation keeps per-destination skill subsets and toggles collection members without changing the intent", () => {
  const pending: Pick<PendingLibraryChange, "facts" | "policies"> = {
    policies: [],
    facts: [
      {
        action: "disable",
        skills: ["review"],
        scope: { kind: "global" },
        destination: "All projects",
        writes: "projection removed",
        collectionLabel: "Tools",
        wholeCollection: true,
      },
      {
        action: "disable",
        skills: ["test"],
        scope: { kind: "repository", root: "/work" },
        destination: "/work",
        writes: "projection removed",
      },
    ],
  };
  const hidden = confirmationPresentation(pending, false, false);
  const shown = confirmationPresentation(pending, true, true);
  expect(hidden.title).toBe("confirm disable");
  expect(hidden.canShowSkills).toBe(true);
  expect(
    hidden.fields.filter((field) => field.label === "applies to").map((field) => field.value),
  ).toEqual(["All projects", "/work"]);
  expect(hidden.fields.some((field) => field.label === "included")).toBe(false);
  expect(shown.fields.filter((field) => field.label === "included")).toEqual([
    { label: "included", value: "review" },
  ]);
  expect(
    shown.fields.filter((field) => field.label === "skills").map((field) => field.value),
  ).toEqual(["1", "test"]);
  expect(pending.facts.map((fact) => fact.skills)).toEqual([["review"], ["test"]]);
});

test("probe results update display facts without mutating the passive audit item", () => {
  const item = auditPresentation(report).sections[1].items[0]!;
  const result: HarnessProbeResult = {
    harnessId: "codex",
    status: "installed",
    command: "codex",
    executablePath: "/bin/codex",
    resolvedPath: "/packages/codex",
    version: "1.0",
    versionOutput: "\ncodex 1.0\n",
    error: null,
  };
  const next = harnessProbePresentation(item, result);
  expect(next).toMatchObject({ status: "clear", harnessProbe: result });
  expect(next.evidence).not.toContain("installation probe: not run · press p");
  expect(item).not.toHaveProperty("harnessProbe");
  expect(detailPresentation(next, false).fields).toEqual(
    expect.arrayContaining([
      { label: "executable", value: "/bin/codex" },
      { label: "resolved", value: "/packages/codex" },
    ]),
  );
  expect(harnessProbePresentation(item, { ...result, status: "missing" }).status).toBe("warning");
  expect(harnessProbePresentation(item, { ...result, status: "failed" }).status).toBe("error");
});
