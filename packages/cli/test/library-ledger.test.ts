import { describe, expect, it } from "vitest";
import { retainedLibraryReferences } from "../src/audit/library-ledger.js";

describe("retained Library references", () => {
  it("reads Skill IDs from Skill-first Library state", () => {
    const skillId = "skill_01m2xxw78pfeva4p3ymmydrc3z";
    const refs = retainedLibraryReferences({
      schemaVersion: 5,
      collections: [],
      skills: [{ skill_id: skillId }],
      projections: [{ skill_id: skillId }],
    });
    expect(refs).toEqual(new Set([skillId]));
  });

  it("does not treat a string that merely resembles a Skill ID as retained", () => {
    expect(
      retainedLibraryReferences({ schemaVersion: 5, skills: [{ skill_id: "skill_01fixture" }] }),
    ).toEqual(new Set());
  });
});
