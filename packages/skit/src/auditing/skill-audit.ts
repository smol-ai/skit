import { createHash } from "node:crypto";
import type {
  Digest,
  SkillAssessmentAcceptance,
  SkillAssessmentContext,
  SkillAssessmentDecision,
  SkillAudit,
  SkillAuditFinding,
} from "../contracts.js";

const MAX_FINDINGS = 100;
const MAX_EXCERPT_CODE_POINTS = 160;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface AuditRule {
  id: string;
  capability: string;
  pattern: RegExp;
  confidence: SkillAuditFinding["confidence"];
  flag?: string;
  critical?: boolean;
}

const RULES: AuditRule[] = [
  {
    id: "process.api-execution",
    capability: "process.execute",
    pattern:
      /(?:\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(|child_process|subprocess\.|os\.system\s*\(|Bun\.spawn\b|Deno\.Command\b)/i,
    confidence: "high",
  },
  {
    id: "process.shell-marker",
    capability: "process.execute",
    pattern: /(?:!`|```!)/i,
    confidence: "high",
  },
  {
    id: "process.shell-fence",
    capability: "process.execute",
    pattern: /```(?:bash|sh|zsh|shell|console)\b/i,
    confidence: "high",
  },
  {
    id: "filesystem.write-operation",
    capability: "filesystem.write",
    pattern: /(?:writeFile|appendFile|apply_patch|\brm\s|unlink)/i,
    confidence: "medium",
  },
  {
    id: "git.commit-command",
    capability: "git.commit",
    pattern: /git\s+commit/i,
    confidence: "high",
  },
  {
    id: "git.push-command",
    capability: "git.push",
    pattern: /git\s+push/i,
    confidence: "high",
    flag: "external_communication",
  },
  {
    id: "network.request-syntax",
    capability: "network.request",
    pattern: /(?:https?:\/\/|\bfetch\s*\(|curl\s)/i,
    confidence: "medium",
  },
  {
    id: "cloud.deployment-command",
    capability: "cloud.deploy",
    pattern:
      /(?:\bwrangler\s+(?:deploy|publish)\b|\bvercel\s+(?:deploy\b|--prod\b)|\bnetlify\s+deploy\b|\bfly(?:ctl)?\s+deploy\b|\bsst\s+deploy\b|\bserverless\s+deploy\b|\bterraform\s+apply\b|\bkubectl\s+apply\b|\bnpm\s+publish\b|\bgh\s+workflow\s+run\b)/i,
    confidence: "high",
    flag: "production_mutation",
  },
  {
    id: "secret.reference",
    capability: "secret.use",
    pattern: /(?:API_KEY|TOKEN|PASSWORD|credential)/i,
    confidence: "medium",
    flag: "credential_reuse",
  },
  {
    id: "process.dynamic-eval",
    capability: "process.execute",
    pattern: /(?:eval\s*\(|new Function)/i,
    confidence: "high",
    flag: "destructive_action",
    critical: true,
  },
];

export interface AuditSkillOptions {
  declaredCapabilities?: string[];
  path?: string;
  fingerprintPath?: string;
  artifactContentDigest?: Digest;
}

export function skillFindingFingerprint(input: {
  capability: string;
  evidence: SkillAuditFinding["evidence"];
  path: string;
  line: number;
  column: number;
  matchedText: string;
}): Digest {
  const hash = createHash("sha256");
  for (const component of [
    "skit/finding/v1",
    input.capability,
    input.evidence,
    input.path,
    String(input.line),
    String(input.column),
    input.matchedText,
  ]) {
    const bytes = Buffer.from(component, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function excerptAt(text: string, index: number, matchLength: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const nextNewline = text.indexOf("\n", index + matchLength);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const line = Array.from(text.slice(lineStart, lineEnd).replace(/\r$/, ""));
  const matchStart = Array.from(text.slice(lineStart, index)).length;
  const matchEnd = matchStart + Array.from(text.slice(index, index + matchLength)).length;
  const context = Math.floor(MAX_EXCERPT_CODE_POINTS / 2);
  let start = Math.max(0, matchStart - context);
  let end = Math.min(line.length, Math.max(matchEnd + context, start + 1));
  const available = MAX_EXCERPT_CODE_POINTS - 2;
  if (end - start > available) {
    const matchSize = Math.min(available, Math.max(1, matchEnd - matchStart));
    const remaining = available - matchSize;
    start = Math.max(0, matchStart - Math.floor(remaining / 2));
    end = Math.min(line.length, start + available);
    start = Math.max(0, end - available);
  }
  return `${start > 0 ? "…" : ""}${line.slice(start, end).join("")}${end < line.length ? "…" : ""}`
    .replace(/\s+/gu, " ")
    .trim();
}

function locationAt(text: string, index: number, matchText: string, path?: string) {
  const before = text.slice(0, index);
  const lastNewline = before.lastIndexOf("\n");
  return {
    ...(path ? { path } : {}),
    line: before.split("\n").length,
    column: Array.from(before.slice(lastNewline + 1)).length + 1,
    excerpt: excerptAt(text, index, matchText.length),
  };
}

export function auditSkill(text: string, options: AuditSkillOptions = {}): SkillAudit {
  const artifactContentDigest =
    options.artifactContentDigest ??
    (`sha256:${createHash("sha256").update(text).digest("hex")}` as Digest);
  const allMatches = RULES.flatMap((rule) => {
    const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace("g", "")}g`);
    return [...text.matchAll(pattern)].map((match) => ({
      rule,
      index: match.index,
      text: match[0],
    }));
  })
    .sort(
      (left, right) => left.index - right.index || compareCodeUnits(left.rule.id, right.rule.id),
    )
    .filter(
      (match, index, all) =>
        index === 0 ||
        match.index !== all[index - 1].index ||
        match.rule.id !== all[index - 1].rule.id,
    );
  const matches = [
    ...allMatches.filter((match) => !match.rule.critical).slice(0, MAX_FINDINGS),
    ...allMatches.filter((match) => match.rule.critical).slice(0, MAX_FINDINGS),
  ].sort(
    (left, right) => left.index - right.index || compareCodeUnits(left.rule.id, right.rule.id),
  );
  const retainedMatchKeys = new Set(
    matches.map((match) => `${match.rule.id}\0${match.index}\0${match.text}`),
  );
  const omittedMatches = allMatches.filter(
    (match) => !retainedMatchKeys.has(`${match.rule.id}\0${match.index}\0${match.text}`),
  );
  const matchedRules = [
    ...new Map(allMatches.map((match) => [match.rule.id, match.rule])).values(),
  ];
  const inferredCapabilities = [
    ...new Set(allMatches.map((match) => match.rule.capability)),
  ].sort();
  const declaredCapabilities = options.declaredCapabilities ?? [];
  const aliases: Record<string, string[]> = {
    "process.execute": ["shell"],
    "filesystem.write": ["filesystem_write"],
    "network.request": ["network"],
    "git.commit": ["shell"],
    "git.push": ["shell", "network"],
    "cloud.deploy": ["shell", "network"],
    "secret.use": ["network"],
  };
  const undeclaredCapabilities = inferredCapabilities.filter(
    (capability) =>
      !declaredCapabilities.includes(capability) &&
      !(aliases[capability] ?? []).every((alias) => declaredCapabilities.includes(alias)),
  );
  const broad = /(?:whenever|always|any task|all requests|do not ask|just do it|JFDI)/i.test(text);
  const suppresses = /(?:do not ask|without (?:asking|confirmation)|never ask|JFDI)/i.test(text);
  const expands = /(?:full access|unrestricted|ignore (?:scope|instructions)|take ownership)/i.test(
    text,
  );
  const findings = matches.map(({ rule, index, text: matchText }) => {
    const location = locationAt(text, index, matchText, options.path);
    const evidence = "statically_possible" as const;
    return {
      ...(options.fingerprintPath !== undefined
        ? {
            fingerprint: skillFindingFingerprint({
              capability: rule.capability,
              evidence,
              path: options.fingerprintPath,
              line: location.line,
              column: location.column,
              matchedText: matchText,
            }),
          }
        : {}),
      analysisProfile: {
        id: "skit/finding/v1" as const,
        scope:
          options.fingerprintPath !== undefined
            ? ("skill_artifact" as const)
            : ("audited_file" as const),
        acceptanceEligible: options.fingerprintPath !== undefined,
      },
      artifactContentDigest,
      ruleId: rule.id,
      evidence,
      severity: rule.critical ? ("critical" as const) : ("medium" as const),
      confidence: rule.confidence,
      capability: rule.capability,
      location,
      message: `Content may exercise ${rule.capability}`,
    };
  });
  const riskFlags = [
    ...new Set([
      ...(broad ? ["broad_implicit_trigger"] : []),
      ...(suppresses ? ["approval_suppression"] : []),
      ...(expands ? ["authority_expansion", "scope_expansion"] : []),
      ...matchedRules.filter((rule) => rule.flag).map((rule) => rule.flag!),
    ]),
  ].sort();
  return {
    ruleset: { id: "skit/skill-static-audit", version: "0.2.0" },
    declaredCapabilities,
    inferredCapabilities,
    undeclaredCapabilities,
    triggerBreadth: broad ? "unbounded" : "narrow",
    authorityEffect: expands ? "expands" : "none",
    confirmationEffect: suppresses ? "suppresses" : "none",
    riskFlags,
    truncatedEvidence: {
      critical: omittedMatches.filter((match) => match.rule.critical).length,
      nonCriticalCapabilities: [
        ...new Set(
          omittedMatches
            .filter((match) => !match.rule.critical)
            .map((match) => match.rule.capability),
        ),
      ].sort(),
    },
    findings,
  };
}

type EvaluateSkillAuditOptions =
  | { context: SkillAssessmentContext }
  | {
      context: SkillAssessmentContext;
      artifactContentDigest: Digest;
      acceptances: readonly SkillAssessmentAcceptance[];
      evaluatedAt: string;
    };

export function evaluateSkillAudit(
  audit: SkillAudit,
  options: EvaluateSkillAuditOptions,
): SkillAssessmentDecision {
  const { context } = options;
  const ruleIds = [...new Set(audit.findings.map((finding) => finding.ruleId))].sort();
  const capabilityIds = [...new Set(audit.inferredCapabilities)].sort();
  const criticalRuleIds = [
    ...new Set(
      audit.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => finding.ruleId),
    ),
  ].sort();
  const reasons = [
    ...(audit.undeclaredCapabilities.length > 0
      ? [{ code: "UNDECLARED_CAPABILITY", ruleIds, capabilityIds: audit.undeclaredCapabilities }]
      : []),
    ...(criticalRuleIds.length > 0
      ? [{ code: "CRITICAL_EVIDENCE", ruleIds: criticalRuleIds, capabilityIds }]
      : []),
    ...(audit.confirmationEffect === "suppresses"
      ? [{ code: "APPROVAL_SUPPRESSION", ruleIds: [], capabilityIds: [] }]
      : []),
    ...(audit.authorityEffect === "expands"
      ? [{ code: "AUTHORITY_EXPANSION", ruleIds: [], capabilityIds: [] }]
      : []),
  ];
  const hasEvidence = audit.findings.length > 0 || audit.riskFlags.length > 0;
  const applicable =
    "acceptances" in options
      ? options.acceptances.filter(
          (acceptance) =>
            acceptance.context === context &&
            acceptance.artifactContentDigest === options.artifactContentDigest &&
            (!acceptance.expiresAt || options.evaluatedAt < acceptance.expiresAt),
        )
      : [];
  const findingDecisions = audit.findings.flatMap((finding) => {
    if (!finding.fingerprint) return [];
    const acceptance = applicable.find((item) => item.fingerprint === finding.fingerprint);
    return [
      {
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        disposition: acceptance ? ("accepted" as const) : ("unresolved" as const),
        ...(acceptance ? { acceptance } : {}),
      },
    ];
  });
  if (!hasEvidence && reasons.length === 0)
    return { context, outcome: "allow", reasons: [], findingDecisions };
  if (context === "publish")
    return {
      context,
      outcome: reasons.length > 0 ? "block" : "warn",
      reasons:
        reasons.length > 0
          ? reasons
          : [{ code: "PUBLISH_REVIEW_RECOMMENDED", ruleIds, capabilityIds }],
      findingDecisions,
    };
  const code = {
    author: "AUTHOR_REVIEW_RECOMMENDED",
    retain: "RETAIN_REVIEW_RECOMMENDED",
    project: "PROJECT_REVIEW_RECOMMENDED",
  }[context];
  return {
    context,
    outcome: "warn",
    reasons: [{ code, ruleIds, capabilityIds }],
    findingDecisions,
  };
}
