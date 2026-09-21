import { isAbsolute, relative, sep } from "node:path";
import type { ContractDataForId } from "../commands/output-contracts.js";
import type { RenderContext } from "./contract-presenters.js";
import { capabilityLabel, severityHeadline } from "./condition-language.js";

export function renderAuditV1Alpha4(
  report: ContractDataForId<"skit.experimental.audit.v1alpha4">,
  context: RenderContext,
): string {
  const displayPath = (path: string) => {
    const fromHome = relative(report.roots.home, path);
    return fromHome === ""
      ? "~"
      : fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome)
        ? `~/${fromHome.split(sep).join("/")}`
        : path;
  };
  const lines = [
    `SKIT audit — ${report.summary.findings ? `${report.summary.findings} ${report.summary.findings === 1 ? "issue" : "issues"}` : "clean"}`,
    `${report.summary.harnesses} detected harnesses in ${report.roots.cwd}`,
    `Skills: ${report.summary.skills}`,
    `Plugins: ${report.summary.plugins}`,
    `MCP servers: ${report.summary.mcpServers}`,
    `Rules: ${report.summary.rules}`,
    `Marketplaces: ${report.summary.marketplaces}`,
  ];
  for (const finding of report.findings)
    lines.push(
      "",
      severityHeadline(finding.severity),
      ...(finding.unresolvedSubject ? [`  ${finding.unresolvedSubject}`] : []),
      `  Problem: ${finding.problem}`,
      ...(finding.locations.length === 1
        ? [`  Where:   ${displayPath(finding.locations[0])}`]
        : ["  Where:", ...finding.locations.map((path) => `    ${displayPath(path)}`)]),
    );
  if (context.detail === "full")
    for (const [kind, capabilities] of [
      ["skill", report.skills],
      ["plugin", report.plugins],
      ["mcp-server", report.mcpServers],
      ["rule", report.rules],
      ["marketplace", report.marketplaces],
    ] as const)
      for (const capability of capabilities)
        lines.push(
          `${capabilityLabel(kind)}\t${capability.harnessIds.join(",")}\t${capability.name}\t${capability.location ?? "unresolved"}`,
        );
  return lines.join("\n");
}
