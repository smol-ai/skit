import { describe, expect, test } from "vitest";
import type { AuditSkillV1Alpha3 } from "../../cli/src/front-end";
import { groupForSkill, groupSkills } from "../src/skill-groups";

describe("skill groups", () => {
  test("uses explicit collection, plugin, and source provenance", () => {
    const skills = [
      {
        provenance: {
          confidence: "exact",
          evidence: "fixture",
          collectionRef: "github:example/tools",
          source: null,
        },
      },
      {
        provenance: {
          confidence: "exact",
          evidence: "fixture",
          parentPlugin: "review@example",
          source: "Plugin registry",
        },
      },
      {
        provenance: {
          confidence: "exact",
          evidence: "fixture",
          source: "Skills CLI / skills.sh",
        },
      },
      { provenance: { confidence: "unknown", evidence: "fixture", source: null } },
    ] satisfies Array<Pick<AuditSkillV1Alpha3, "provenance" | "canonicalLocation">>;

    const groups = groupSkills(skills);

    expect(groups.map(({ identity, label }) => ({ identity, label }))).toEqual([
      { identity: { kind: "all" }, label: "All skills" },
      {
        identity: { kind: "collection", ref: "github:example/tools" },
        label: "github:example/tools",
      },
      { identity: { kind: "plugin", ref: "review@example" }, label: "review@example" },
      {
        identity: { kind: "source", name: "Skills CLI / skills.sh" },
        label: "Skills CLI / skills.sh",
      },
      { identity: { kind: "unattributed" }, label: "Unattributed" },
    ]);
    expect(groupForSkill(groups, skills[1]!)?.identity).toEqual({
      kind: "plugin",
      ref: "review@example",
    });
  });

  test("counts one canonical skill and keeps its strongest provenance", () => {
    const skills = [
      {
        canonicalLocation: "/skills/review/SKILL.md",
        provenance: { confidence: "exact", evidence: "root", source: "Skills CLI / skills.sh" },
      },
      {
        canonicalLocation: "/skills/review/SKILL.md",
        provenance: {
          confidence: "exact",
          evidence: "projection",
          source: "SKIT projection",
          collectionRef: "github:example/tools",
          parentPlugin: "review@example",
        },
      },
    ] satisfies Array<Pick<AuditSkillV1Alpha3, "provenance" | "canonicalLocation">>;

    const groups = groupSkills(skills);

    expect(groups[0]?.skills).toHaveLength(1);
    expect(groups[1]?.identity).toEqual({ kind: "collection", ref: "github:example/tools" });
  });
});
