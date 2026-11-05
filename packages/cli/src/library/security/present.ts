import type { SkillSecurityReview } from "@smolai/skit-core/audit";

export function renderSecurityReview(data: typeof SkillSecurityReview.Type): string {
  return data.audit.findings.length
    ? data.assessment.findingDecisions
        .map((finding) => `${finding.fingerprint} ${finding.disposition} (${finding.ruleId})`)
        .join("\n")
    : "No security findings";
}
