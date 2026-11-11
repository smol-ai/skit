import { describe, expect, test } from "vitest";
import type { AuditSkillV1Alpha4 } from "@smolai/skit-core/audit";
import { groupForSkill, groupSkills } from "../src/audit/skill-groups";

describe("skill groups", () => {
  test("uses explicit collection, plugin, and source provenance", () => {
    const skills = [
      {
        provenance: {
          confidence: "exact",
          evidence: "fixture",
          collectionId: "coll_01m2xxw78tfeva4p48mn5xbprh",
          origin: { _tag: "Unknown" },
        },
      },
      {
        provenance: {
          confidence: "exact",
          evidence: "fixture",
          parentPlugin: "review@example",
          origin: { _tag: "PluginRegistry", harness: "claude-code" },
        },
      },
      {
        provenance: {
          confidence: "exact",
          evidence: "fixture",
          origin: { _tag: "SkillsSh" },
        },
      },
      { provenance: { confidence: "unknown", evidence: "fixture", origin: { _tag: "Unknown" } } },
    ] satisfies Array<Pick<AuditSkillV1Alpha4, "provenance" | "canonicalLocation">>;

    const groups = groupSkills(skills);

    expect(groups.map(({ identity, label }) => ({ identity, label }))).toEqual([
      { identity: { kind: "all" }, label: "All skills" },
      {
        identity: { kind: "collection", id: "coll_01m2xxw78tfeva4p48mn5xbprh" },
        label: "coll_01m2xxw78tfeva4p48mn5xbprh",
      },
      { identity: { kind: "plugin", id: "review@example" }, label: "review@example" },
      {
        identity: { kind: "source", origin: { _tag: "SkillsSh" } },
        label: "skills.sh",
      },
      { identity: { kind: "unattributed" }, label: "Unattributed" },
    ]);
    expect(groupForSkill(groups, skills[1]!)?.identity).toEqual({
      kind: "plugin",
      id: "review@example",
    });
  });

  test("package origins group by package and version regardless of property order", () => {
    const first = { _tag: "PnpmPackage", package: "@acme/review", version: "1.0.0" } as const;
    const reordered = { version: "1.0.0", package: "@acme/review", _tag: "PnpmPackage" } as const;
    const next = { ...first, version: "2.0.0" };
    const skills = [first, next, reordered].map((origin) => ({
      provenance: {
        confidence: "exact" as const,
        evidence: "/workspace/node_modules/.modules.yaml",
        origin,
      },
    }));
    const groups = groupSkills(skills);
    expect(groups).toHaveLength(3);
    expect(groupForSkill(groups, skills[0]!)).toBe(groupForSkill(groups, skills[2]!));
    expect(groupForSkill(groups, skills[0]!)?.skills).toHaveLength(2);
    expect(groupForSkill(groups, skills[0]!)?.identity).toEqual({ kind: "source", origin: first });
    expect(groupForSkill(groups, skills[1]!)?.identity).toEqual({ kind: "source", origin: next });
  });

  test("counts one canonical skill and keeps its strongest provenance", () => {
    const skills = [
      {
        canonicalLocation: "/skills/review/SKILL.md",
        provenance: { confidence: "exact", evidence: "root", origin: { _tag: "SkillsSh" } },
      },
      {
        canonicalLocation: "/skills/review/SKILL.md",
        provenance: {
          confidence: "exact",
          evidence: "projection",
          origin: { _tag: "SkitManaged" },
          collectionId: "coll_01m2xxw78tfeva4p48mn5xbprh",
          parentPlugin: "review@example",
        },
      },
    ] satisfies Array<Pick<AuditSkillV1Alpha4, "provenance" | "canonicalLocation">>;

    const groups = groupSkills(skills);

    expect(groups[0]?.skills).toHaveLength(1);
    expect(groups[1]?.identity).toEqual({
      kind: "collection",
      id: "coll_01m2xxw78tfeva4p48mn5xbprh",
    });
  });
});
