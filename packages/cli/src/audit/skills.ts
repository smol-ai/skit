import { basename, dirname, join } from "node:path";
import {
  auditSkill,
  evaluateSkillFrontmatter,
  harnessProfile,
  observationPathIdentityEffect,
  resolveHarnessRoot,
  type HarnessProfile,
  type HarnessRoot,
  type HarnessRootRole,
  type HarnessName,
  type JsonObject,
} from "@smolai/skit-core";
import { Effect } from "effect";
import { auditHarnesses } from "../harness/catalog.js";
import { canonical, read, walk } from "./io.js";
import { fileProvenance } from "./provenance.js";
import type { AuditFinding, AuditObservation } from "./types.js";

function frontmatterProblem(
  issue: ReturnType<typeof evaluateSkillFrontmatter>["issues"][number],
): string {
  const field = issue.field ? ` ${issue.field}` : " a field";
  switch (issue.code) {
    case "frontmatter-invalid":
      return "Skill frontmatter is not valid YAML metadata";
    case "frontmatter-missing":
      return "Skill frontmatter is missing";
    case "field-unknown":
      return `Skill frontmatter${field} is not recognized by this Harness`;
    case "field-missing":
      return `Skill frontmatter is missing${field} required by this Harness`;
    case "field-type":
      return `Skill frontmatter${field} has the wrong value type`;
    case "field-constraint":
      return `Skill frontmatter${field} does not meet this Harness's requirements`;
  }
}

export interface SkillAuditResult {
  profiles: HarnessProfile[];
  observations: AuditObservation[];
  findings: AuditFinding[];
}

export interface SkillCandidate {
  path: string;
  canonicalPath: string;
  name: string;
  harnesses: readonly HarnessName[];
  role: HarnessRootRole;
  scope: "user" | "project";
  provenance?: AuditObservation["provenance"];
}

export interface InspectSkillInput extends SkillCandidate {
  aliases: string[];
  provenance: AuditObservation["provenance"];
}

export const inspectSkill = Effect.fn("Audit.inspectSkill")(function* (input: InspectSkillInput) {
  const body = (yield* read(input.path)) ?? "";
  const directoryName = basename(dirname(input.path));
  const compatibility = input.harnesses.map((harness) =>
    evaluateSkillFrontmatter(body, harness, { directoryName }),
  );
  return {
    observation: {
      kind: "skill" as const,
      name: input.name,
      harnesses: input.harnesses,
      role: input.role,
      scope: input.scope,
      path: input.path,
      canonicalPath: input.canonicalPath,
      aliases: input.aliases,
      provenance: input.provenance,
      staticAudit: auditSkill(body, { path: input.path }),
      frontmatterCompatibility: compatibility,
    },
    findings: compatibility.flatMap((result) =>
      result.issues.map((issue) => ({
        severity: issue.severity === "error" ? ("error" as const) : ("warning" as const),
        code: `skill-${issue.code}`,
        subject: input.path,
        problem: frontmatterProblem(issue),
        locations: [input.path],
        details: {
          harness: result.harness,
          contractId: result.contractId,
          variant: result.variant,
          field: issue.field,
          sourceIds: [...issue.sourceIds],
        },
      })),
    ),
  };
});

interface AuditedRoot {
  harnesses: Set<HarnessName>;
  roles: Set<HarnessRootRole>;
  scope: "user" | "project";
  path: string;
}

export const auditSkills = Effect.fn("Audit.skills")(function* (
  home: string,
  cwd: string,
  lock: JsonObject,
  additional: readonly SkillCandidate[] = [],
) {
  const profiles = auditHarnesses.map((entry) => harnessProfile(entry.id));
  const roots = new Map<string, AuditedRoot>();
  const context = { home, configHome: join(home, ".config"), repository: cwd };
  for (const profile of profiles)
    for (const root of profile.roots.filter((candidate) => candidate.readable)) {
      const path = resolveHarnessRoot(root as HarnessRoot, context);
      const scope = root.scope === "global" ? "user" : "project";
      const key = `${scope}\0${(yield* observationPathIdentityEffect(path)).comparisonKey}`;
      const entry = roots.get(key) ?? { harnesses: new Set(), roles: new Set(), scope, path };
      if (root.role === "native" && !entry.roles.has("native")) entry.path = path;
      entry.harnesses.add(profile.id);
      entry.roles.add(root.role);
      roots.set(key, entry);
    }

  const rootCandidates: SkillCandidate[] = [];
  for (const root of roots.values())
    for (const path of yield* walk(root.path, (candidate) => basename(candidate) === "SKILL.md"))
      rootCandidates.push({
        path,
        canonicalPath: yield* canonical(path),
        name: basename(dirname(path)),
        harnesses: [...root.harnesses],
        // A physical root shared across harnesses is classified conservatively by its least-native
        // consumer. This deliberate collapse keeps one observation per discovered root entry.
        role: root.roles.has("compatibility") ? ("compatibility" as const) : ("native" as const),
        scope: root.scope,
      });
  const candidates = [...rootCandidates];
  const lockEligiblePaths = new Set(rootCandidates.map((candidate) => candidate.canonicalPath));
  candidates.push(...additional);
  const aliases = new Map<string, string[]>();
  const lockTargets = new Map<string, Set<string>>();
  for (const skill of rootCandidates) {
    const baseName = basename(dirname(skill.path));
    const targets = lockTargets.get(baseName) ?? new Set<string>();
    targets.add(skill.canonicalPath);
    lockTargets.set(baseName, targets);
  }
  for (const skill of candidates) {
    aliases.set(skill.canonicalPath, [...(aliases.get(skill.canonicalPath) ?? []), skill.path]);
  }

  const observations: AuditObservation[] = [];
  const findings: AuditFinding[] = [];
  for (const skill of candidates) {
    const baseName = basename(dirname(skill.path));
    const occurrences = lockTargets.get(baseName)?.size ?? 1;
    const file = yield* fileProvenance(
      skill.path,
      lockEligiblePaths.has(skill.canonicalPath) ? lock : {},
      baseName,
      occurrences,
    );
    const provenance =
      file.source === "SKIT projection" || file.source === "Skills CLI / skills.sh"
        ? file
        : (skill.provenance ?? file);
    const inspected = yield* inspectSkill({
      ...skill,
      aliases: [...new Set(aliases.get(skill.canonicalPath) ?? [skill.path])],
      // A projection ownership marker or lockfile is authoritative; adapter provenance is the
      // fallback. fileProvenance checks the marker before consulting the lockfile.
      provenance: {
        ...provenance,
        ...(skill.provenance?.parentPlugin ? { parentPlugin: skill.provenance.parentPlugin } : {}),
      },
    });
    observations.push(inspected.observation);
    findings.push(...inspected.findings);
  }
  for (const [name, targets] of lockTargets)
    if (targets.size > 1 && lock[name])
      findings.push({
        severity: "warning",
        code: "ambiguous-lockfile-attribution",
        subject: name,
        problem: `Skill “${name}” has ambiguous lockfile attribution`,
        locations: [...targets],
        details: { skill: name, occurrences: targets.size },
      });
  return { profiles, observations, findings };
});
