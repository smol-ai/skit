import type { HarnessName } from "@smolai/skit-core";
import type { AuditObservation, AuditReport } from "./types.js";
import type { AuditEntryV1Alpha4, AuditReportV1Alpha4 } from "./schema.js";

type IndexedEntry = AuditEntryV1Alpha4 & {
  sourceKind: AuditObservation["kind"];
  sourceName: string;
  sourceLocation: string | null;
  sourceCanonicalLocation?: string;
};

function auditEntryBase(observation: AuditObservation, id: string) {
  return {
    id,
    name: observation.name,
    harnessIds: [...observation.harnesses],
    scope: observation.scope,
    location: observation.path,
    ...(observation.canonicalPath ? { canonicalLocation: observation.canonicalPath } : {}),
    provenance: observation.provenance,
  };
}

export function normalizeAuditReport(report: AuditReport): AuditReportV1Alpha4 {
  const indexed: IndexedEntry[] = report.observations.map((observation, index) => {
    const id = `entry:${observation.kind}:${index + 1}`;
    const base = auditEntryBase(observation, id);
    const entry: AuditEntryV1Alpha4 = (() => {
      switch (observation.kind) {
        case "skill":
          return {
            ...base,
            role: observation.role ?? "compatibility",
            aliases: observation.aliases ?? [],
            ...(observation.staticAudit ? { staticAudit: observation.staticAudit } : {}),
            ...(observation.frontmatterCompatibility
              ? { frontmatterCompatibility: observation.frontmatterCompatibility }
              : {}),
          };
        case "plugin":
          return {
            ...base,
            installed: observation.installed ?? false,
            enabled: observation.enabled ?? null,
          };
        case "mcp-server":
          return {
            ...base,
            enabled: observation.enabled ?? null,
            active: observation.active ?? false,
            transport: observation.mcp?.transport ?? "unknown",
            ...(observation.mcp?.command ? { command: observation.mcp.command } : {}),
            args: observation.mcp?.args ?? [],
            ...(observation.mcp?.cwd ? { cwd: observation.mcp.cwd } : {}),
            ...(observation.mcp?.url ? { url: observation.mcp.url } : {}),
          };
        case "rule":
        case "marketplace":
          return base;
      }
    })();
    return {
      ...entry,
      sourceKind: observation.kind,
      sourceName: observation.name,
      sourceLocation: observation.path,
      ...(observation.canonicalPath ? { sourceCanonicalLocation: observation.canonicalPath } : {}),
    };
  });

  const entriesFor = (kind: AuditObservation["kind"]): AuditEntryV1Alpha4[] =>
    indexed
      .filter((capability) => capability.sourceKind === kind)
      .map(
        ({
          sourceKind: _kind,
          sourceName: _name,
          sourceLocation: _location,
          sourceCanonicalLocation: _canonical,
          ...entry
        }) => entry,
      );
  const observedHarnessIds = new Set(indexed.flatMap((capability) => capability.harnessIds));
  const supported = new Map(report.coverage.supported.map((profile) => [profile.id, profile]));
  const harnessIds = new Set<HarnessName>([
    ...report.coverage.supported.map((profile) => profile.id as HarnessName),
    ...observedHarnessIds,
  ]);

  return {
    schemaVersion: "v1alpha4",
    generatedAt: report.generatedAt,
    roots: { home: report.home, cwd: report.cwd },
    harnesses: [...harnessIds].sort().map((id) => {
      const profile = supported.get(id);
      return {
        id,
        detected: observedHarnessIds.has(id),
        profileId: profile?.profileId ?? "unknown",
        profileVersion: profile?.version ?? "unknown",
        frontmatterContracts: [...(profile?.frontmatterContracts ?? [])],
        skillMetadataContracts: [...(profile?.skillMetadataContracts ?? [])],
        documentation: [...(profile?.documentation ?? [])],
        entryIds: indexed.filter((entry) => entry.harnessIds.includes(id)).map((entry) => entry.id),
      };
    }),
    skills: entriesFor("skill") as AuditReportV1Alpha4["skills"],
    plugins: entriesFor("plugin") as AuditReportV1Alpha4["plugins"],
    mcpServers: entriesFor("mcp-server") as AuditReportV1Alpha4["mcpServers"],
    rules: entriesFor("rule") as AuditReportV1Alpha4["rules"],
    marketplaces: entriesFor("marketplace") as AuditReportV1Alpha4["marketplaces"],
    findings: report.findings.map((finding, index) => {
      const entryIds = indexed
        .filter(
          (capability) =>
            finding.subject === capability.sourceName ||
            finding.subject === capability.sourceLocation ||
            finding.subject === capability.sourceCanonicalLocation,
        )
        .map((capability) => capability.id);
      return {
        id: `finding:${index + 1}`,
        severity: finding.severity,
        code: finding.code,
        entryIds,
        unresolvedSubject: entryIds.length === 0 ? finding.subject : null,
        problem: finding.problem,
        locations: [...finding.locations],
        details: finding.details,
      };
    }),
    probes: report.probes.map(({ harness, ...probe }) => ({ harnessId: harness, ...probe })),
    coverage: { deferredHarnessIds: [...report.coverage.deferred] },
    summary: {
      harnesses: observedHarnessIds.size,
      skills: indexed.filter((capability) => capability.sourceKind === "skill").length,
      plugins: indexed.filter((capability) => capability.sourceKind === "plugin").length,
      mcpServers: indexed.filter((capability) => capability.sourceKind === "mcp-server").length,
      rules: indexed.filter((capability) => capability.sourceKind === "rule").length,
      marketplaces: indexed.filter((capability) => capability.sourceKind === "marketplace").length,
      findings: report.findings.length,
    },
  };
}
