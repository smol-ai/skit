import type { SkillSecurityReview } from "@smolai/skit-core/audit";
import { Block } from "../../terminal/blocks.js";

export function renderSecurityReview(data: SkillSecurityReview): Block[] {
  return data.audit.findings.length
    ? [
        Block.Table({
          columns: [{ title: "Finding" }, { title: "Disposition" }, { title: "Rule" }],
          rows: data.assessment.findingDecisions.map((finding) => [
            [finding.fingerprint],
            [finding.disposition],
            [{ dim: finding.ruleId }],
          ]),
        }),
      ]
    : [Block.Status({ tone: "ok", text: ["No security findings"] })];
}
