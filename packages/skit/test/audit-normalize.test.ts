import { describe, expect, test } from "vitest";
import { normalizeAuditReport } from "../src/auditing/normalize.js";
import type { AuditReport } from "../src/auditing/schema.js";

describe("normalized audit report", () => {
  test("links findings by subject identity rather than arbitrary detail values", () => {
    const report: AuditReport = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      home: "/home/example",
      cwd: "/repo",
      coverage: { supported: [], deferred: [] },
      observations: [
        {
          kind: "mcp-server",
          name: "codex",
          harnesses: ["claude-code"],
          scope: "user",
          path: "/home/example/.claude/settings.json",
          mcp: { transport: "http", url: "https://example.test/mcp", args: [] },
          provenance: {
            confidence: "exact",
            origin: { _tag: "Configuration", harness: "claude-code" },
            evidence: "config",
          },
        },
        {
          kind: "skill",
          name: "example",
          harnesses: ["codex"],
          role: "native",
          scope: "user",
          path: "/home/example/.codex/skills/example/SKILL.md",
          provenance: {
            confidence: "unknown",
            origin: { _tag: "Unknown" },
            evidence: "skill root",
          },
        },
      ],
      findings: [
        {
          severity: "warning",
          code: "skill-field-unknown",
          subject: "/home/example/.codex/skills/example/SKILL.md",
          reason: {
            _tag: "FrontmatterCompatibility",
            harness: "codex",
            issue: { code: "field-unknown", field: "metadata", severity: "unknown", sourceIds: [] },
          },
          locations: ["/home/example/.codex/skills/example/SKILL.md"],
          details: { harness: "codex", field: "metadata" },
        },
      ],
      probes: [],
      summary: { capabilities: 2, findings: 1 },
    };

    const normalized = normalizeAuditReport(report);
    expect(normalized.skills[0]?.provenance).toBe(report.observations[1]?.provenance);
    expect(normalized.findings[0]?.entryIds).toEqual([normalized.skills[0]?.id]);
    expect(normalized.findings[0]?.entryIds).not.toContain(normalized.mcpServers[0]?.id);
    expect(normalized.findings[0]?.unresolvedSubject).toBeNull();
    expect(normalized.mcpServers[0]).toEqual(
      expect.objectContaining({
        transport: "http",
        url: "https://example.test/mcp",
        args: [],
      }),
    );
  });
});
