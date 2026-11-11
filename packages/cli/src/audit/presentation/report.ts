import { auditProbeFailure } from "../../platform/probe-failures.js";
import type { ContractDataForId } from "../../commands/output-contracts.js";
import { Block } from "../../terminal/blocks.js";
import type { RenderContext } from "../../terminal/contracts.js";
import { auditFinding } from "./findings.js";
import { capabilityLabel } from "./language.js";

export function presentAuditV1Alpha4(
  report: ContractDataForId<"skit.experimental.audit.v1alpha4">,
  context: RenderContext,
): Block[] {
  const capabilities = (
    [
      ["skill", report.skills],
      ["plugin", report.plugins],
      ["mcp-server", report.mcpServers],
      ["rule", report.rules],
      ["marketplace", report.marketplaces],
    ] as const
  ).flatMap(([kind, found]) =>
    found.map((capability) => [
      [capabilityLabel(kind)],
      [capability.harnessIds.join(",")],
      [capability.name],
      [capability.location ?? { dim: "unresolved" }],
    ]),
  );
  return [
    Block.Heading({
      text: `SKIT audit — ${report.summary.findings ? `${report.summary.findings} ${report.summary.findings === 1 ? "issue" : "issues"}` : "clean"}`,
    }),
    Block.Note({
      text: [
        `${report.summary.harnesses} detected ${report.summary.harnesses === 1 ? "harness" : "harnesses"} in `,
        { path: report.roots.cwd },
      ],
    }),
    Block.Fields({
      rows: [
        { label: "Skills", value: [String(report.summary.skills)] },
        { label: "Plugins", value: [String(report.summary.plugins)] },
        { label: "MCP servers", value: [String(report.summary.mcpServers)] },
        { label: "Rules", value: [String(report.summary.rules)] },
        { label: "Marketplaces", value: [String(report.summary.marketplaces)] },
      ],
    }),
    ...(report.probes.length
      ? [
          Block.Group({
            title: "Probes",
            children: [
              Block.Table({
                columns: [{ title: "Harness" }, { title: "Status" }, { title: "Result" }],
                rows: report.probes.map((probe) => [
                  [probe.harnessId],
                  [probe.status],
                  [
                    probe.failure
                      ? auditProbeFailure(probe.failure)
                      : Object.entries(probe.observed ?? {})
                          .map(([key, count]) => `${key}: ${count}`)
                          .join(", "),
                  ],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...report.findings.map(auditFinding),
    ...(context.detail === "full" && capabilities.length
      ? [
          Block.Table({
            columns: [
              { title: "Capability" },
              { title: "Harnesses" },
              { title: "Name" },
              { title: "Location" },
            ],
            rows: capabilities,
          }),
        ]
      : []),
  ];
}
