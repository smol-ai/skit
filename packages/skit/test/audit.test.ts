import { describe, expect, test } from "vitest";
import { auditSkill, evaluateSkillAudit, skillFindingFingerprint } from "../src/index.js";
import { makeSkillVersionId } from "../src/library/entity-ids.js";

describe("static capability evidence", () => {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const skillVersionId = makeSkillVersionId();

  test("uses portable evidence identity only for resolved Skill Artifacts", () => {
    const left = auditSkill('spawn("sh")', {
      path: "/machine-a/skills/review/SKILL.md",
      fingerprintPath: "SKILL.md",
      artifactContentDigest: digest,
    });
    const right = auditSkill('spawn("sh")', {
      path: "/machine-b/skills/review/SKILL.md",
      fingerprintPath: "SKILL.md",
      artifactContentDigest: digest,
    });
    const inventory = auditSkill('spawn("sh")', {
      path: "/machine-a/skills/review/SKILL.md",
    });

    expect(left.findings[0].fingerprint).toBe(right.findings[0].fingerprint);
    expect(left.findings[0]).toEqual(
      expect.objectContaining({
        artifactContentDigest: digest,
        analysisProfile: {
          id: "skit/finding/v1",
          scope: "skill_artifact",
          acceptanceEligible: true,
        },
      }),
    );
    expect(inventory.findings[0].fingerprint).toBeUndefined();
    expect(inventory.findings[0].analysisProfile.acceptanceEligible).toBe(false);
  });

  test("uses an unambiguous, detector-independent fingerprint preimage", () => {
    const base = {
      evidence: "statically_possible" as const,
      path: "SKILL.md",
      line: 1,
      column: 1,
      matchedText: "spawn",
    };

    expect(skillFindingFingerprint({ ...base, capability: "a\0b" })).not.toBe(
      skillFindingFingerprint({ ...base, capability: "a", matchedText: "b\0spawn" }),
    );
  });

  test("tracks Project acceptance without making it an enablement gate", () => {
    const audit = auditSkill('spawn("sh")', {
      fingerprintPath: "SKILL.md",
      artifactContentDigest: digest,
    });
    const acceptance = {
      fingerprint: audit.findings[0].fingerprint!,
      artifactContentDigest: digest,
      skill_version_id: skillVersionId,
      context: "project" as const,
      principal: "principal:test",
      rationale: "Reviewed exact evidence",
      acceptedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    };

    expect(evaluateSkillAudit(audit, { context: "project" }).outcome).toBe("warn");
    expect(
      evaluateSkillAudit(audit, {
        context: "project",
        artifactContentDigest: digest,
        acceptances: [acceptance],
        evaluatedAt: "2026-09-01T23:59:59.999Z",
      }),
    ).toEqual(
      expect.objectContaining({
        outcome: "warn",
        findingDecisions: [expect.objectContaining({ disposition: "accepted", acceptance })],
      }),
    );
    expect(
      evaluateSkillAudit(audit, {
        context: "project",
        artifactContentDigest: digest,
        acceptances: [acceptance],
        evaluatedAt: acceptance.expiresAt,
      }),
    ).toEqual(
      expect.objectContaining({
        outcome: "warn",
        findingDecisions: [expect.objectContaining({ disposition: "unresolved" })],
      }),
    );
    expect(
      evaluateSkillAudit(audit, {
        context: "project",
        artifactContentDigest: `sha256:${"b".repeat(64)}`,
        acceptances: [acceptance],
        evaluatedAt: "2026-09-01T12:00:00.000Z",
      }),
    ).toEqual(
      expect.objectContaining({
        outcome: "warn",
        findingDecisions: [expect.objectContaining({ disposition: "unresolved" })],
      }),
    );
    expect(
      evaluateSkillAudit(audit, {
        context: "publish",
        artifactContentDigest: digest,
        acceptances: [acceptance],
        evaluatedAt: "2026-09-01T12:00:00.000Z",
      }).outcome,
    ).toBe("block");
  });

  test("tracks acceptance for each distinct Project evidence location", () => {
    const audit = auditSkill('spawn("one")\nspawn("two")', {
      fingerprintPath: "SKILL.md",
      artifactContentDigest: digest,
    });
    const acceptanceFor = (index: number) => ({
      fingerprint: audit.findings[index].fingerprint!,
      artifactContentDigest: digest,
      skill_version_id: skillVersionId,
      context: "project" as const,
      principal: "principal:test",
      rationale: "Reviewed exact evidence",
      acceptedAt: "2026-09-01T00:00:00.000Z",
    });
    const evaluate = (acceptances: ReturnType<typeof acceptanceFor>[]) =>
      evaluateSkillAudit(audit, {
        context: "project",
        artifactContentDigest: digest,
        acceptances,
        evaluatedAt: "2026-09-01T01:00:00.000Z",
      });

    expect(evaluate([acceptanceFor(0)]).findingDecisions).toEqual([
      expect.objectContaining({ disposition: "accepted" }),
      expect.objectContaining({ disposition: "unresolved" }),
    ]);
    expect(evaluate([acceptanceFor(0), acceptanceFor(1)]).findingDecisions).toEqual([
      expect.objectContaining({ disposition: "accepted" }),
      expect.objectContaining({ disposition: "accepted" }),
    ]);
  });
  test.each([
    "Spawn one subagent per reviewer, in parallel.",
    "queues, workflows, webhooks, migrations, deploys, multi-tenant writes",
    "one deployment target updating before another",
    "Deploy and migration as concurrent actors.",
    "review code that deploys to production",
    "results.exec(input)",
  ])("does not infer executable capability from benign prose: %s", (text) => {
    const audit = auditSkill(text);

    expect(audit.inferredCapabilities).toEqual([]);
    expect(audit.findings).toEqual([]);
    expect(evaluateSkillAudit(audit, { context: "publish" }).outcome).toBe("allow");
  });

  test.each([
    ["const child = require('node:child_process')", "process.api-execution", "process.execute"],
    ['spawn("bash", ["-c", cmd])', "process.api-execution", "process.execute"],
    ["```bash\necho hello\n```", "process.shell-fence", "process.execute"],
    ["Run !`git push` after review.", "process.shell-marker", "process.execute"],
    ["wrangler deploy", "cloud.deployment-command", "cloud.deploy"],
    ["eval(source)", "process.dynamic-eval", "process.execute"],
  ])("retains concrete capability evidence: %s", (text, ruleId, capability) => {
    const audit = auditSkill(text);
    const finding = audit.findings.find((candidate) => candidate.ruleId === ruleId);

    expect(audit.inferredCapabilities).toContain(capability);
    expect(finding).toEqual(expect.objectContaining({ ruleId, capability, confidence: "high" }));
    expect(evaluateSkillAudit(audit, { context: "publish" }).outcome).toBe("block");
  });

  test("uses distinct detector identities for one inferred capability", () => {
    const audit = auditSkill('spawn("sh") then eval(source)');

    expect(audit.inferredCapabilities).toEqual(["process.execute"]);
    expect(audit.findings.map((finding) => finding.ruleId)).toEqual([
      "process.api-execution",
      "process.dynamic-eval",
    ]);
    expect(audit.findings.map((finding) => finding.severity)).toEqual(["medium", "critical"]);
  });

  test("reports every occurrence in deterministic source order", () => {
    const audit = auditSkill('spawn("a")\nwrangler deploy\nspawn("b")');

    expect(audit.findings.map((finding) => finding.ruleId)).toEqual([
      "process.api-execution",
      "cloud.deployment-command",
      "process.api-execution",
    ]);
    expect(audit.findings.map((finding) => finding.location.line)).toEqual([1, 2, 3]);
  });

  test.each([
    ['alpha\r\nxx spawn("sh")', 2, 4],
    ['α😀\nxx spawn("sh")', 2, 4],
    ['α😀 spawn("sh")', 1, 4],
  ])("reports code-point locations for LF, CRLF, and Unicode: %s", (text, line, column) => {
    const audit = auditSkill(text, { path: "skills/review/SKILL.md" });

    expect(audit.findings[0].location).toEqual(
      expect.objectContaining({ path: "skills/review/SKILL.md", line, column }),
    );
  });

  test("bounds excerpts without splitting Unicode code points", () => {
    const text = `${"a".repeat(200)}😀 spawn("sh") ${"b".repeat(200)}`;
    const excerpt = auditSkill(text).findings[0].location.excerpt;

    expect(Array.from(excerpt).length).toBeLessThanOrEqual(160);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain("😀 spawn(");
    expect(excerpt).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  test("normalizes multiline excerpt whitespace", () => {
    const excerpt = auditSkill('before\t\tspawn("sh")   after').findings[0].location.excerpt;

    expect(excerpt).toBe('before spawn("sh") after');
  });

  test("bounds findings from repetitive hostile input", () => {
    const audit = auditSkill(Array.from({ length: 150 }, () => 'spawn("sh")').join("\n"));

    expect(audit.findings).toHaveLength(100);
    expect(audit.findings.at(-1)?.location.line).toBe(100);
  });

  test("bounds repetitive critical findings without losing honest policy attribution", () => {
    const audit = auditSkill(Array.from({ length: 5_000 }, () => "eval(source)").join("\n"), {
      fingerprintPath: "SKILL.md",
      artifactContentDigest: digest,
    });

    expect(audit.findings).toHaveLength(100);
    expect(audit.findings.at(-1)).toEqual(
      expect.objectContaining({
        ruleId: "process.dynamic-eval",
        severity: "critical",
        location: expect.objectContaining({ line: 100 }),
      }),
    );
    expect(evaluateSkillAudit(audit, { context: "publish" })).toEqual(
      expect.objectContaining({
        outcome: "block",
        reasons: expect.arrayContaining([
          expect.objectContaining({
            code: "CRITICAL_EVIDENCE",
            ruleIds: ["process.dynamic-eval"],
          }),
        ]),
      }),
    );
    const acceptedVisibleFindings = audit.findings.map((finding) => ({
      fingerprint: finding.fingerprint!,
      artifactContentDigest: digest,
      skill_version_id: skillVersionId,
      context: "project" as const,
      principal: "principal:test",
      rationale: "Reviewed visible evidence",
      acceptedAt: "2026-09-01T00:00:00.000Z",
    }));
    expect(
      evaluateSkillAudit(audit, {
        context: "project",
        artifactContentDigest: digest,
        acceptances: acceptedVisibleFindings,
        evaluatedAt: "2026-09-01T01:00:00.000Z",
      }),
    ).toEqual(
      expect.objectContaining({
        outcome: "warn",
        reasons: [expect.objectContaining({ code: "PROJECT_REVIEW_RECOMMENDED" })],
      }),
    );
  });

  test("retains policy evidence beyond the finding-count bound", () => {
    const text = `${Array.from({ length: 100 }, () => 'spawn("sh")').join("\n")}\neval(source)`;
    const audit = auditSkill(text, { declaredCapabilities: ["shell"] });

    expect(audit.findings).toHaveLength(101);
    expect(audit.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "process.dynamic-eval",
        severity: "critical",
        location: expect.objectContaining({ line: 101 }),
      }),
    );
    expect(audit.riskFlags).toContain("destructive_action");
    expect(evaluateSkillAudit(audit, { context: "publish" })).toEqual(
      expect.objectContaining({
        outcome: "block",
        reasons: expect.arrayContaining([
          expect.objectContaining({
            code: "CRITICAL_EVIDENCE",
            ruleIds: ["process.dynamic-eval"],
          }),
        ]),
      }),
    );
  });

  test("uses declared capabilities only for policy metadata, not evidence discovery", () => {
    const audit = auditSkill('spawn("sh")', {
      declaredCapabilities: ["shell"],
      path: "SKILL.md",
    });

    expect(audit.findings).toHaveLength(1);
    expect(audit.undeclaredCapabilities).toEqual([]);
    expect(evaluateSkillAudit(audit, { context: "publish" }).outcome).toBe("warn");
  });

  test("evaluates the same evidence by explicit policy context", () => {
    const audit = auditSkill('spawn("sh")');

    expect(evaluateSkillAudit(audit, { context: "author" })).toEqual(
      expect.objectContaining({ context: "author", outcome: "warn" }),
    );
    expect(evaluateSkillAudit(audit, { context: "retain" })).toEqual(
      expect.objectContaining({
        context: "retain",
        outcome: "warn",
        reasons: [expect.objectContaining({ code: "RETAIN_REVIEW_RECOMMENDED" })],
      }),
    );
    expect(evaluateSkillAudit(audit, { context: "project" })).toEqual(
      expect.objectContaining({
        context: "project",
        outcome: "warn",
        reasons: [expect.objectContaining({ code: "PROJECT_REVIEW_RECOMMENDED" })],
      }),
    );
    expect(evaluateSkillAudit(audit, { context: "publish" })).toEqual(
      expect.objectContaining({ context: "publish", outcome: "block" }),
    );
  });
});
