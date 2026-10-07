import { expect, test } from "vitest";
import { estimateCodexListing } from "../src/harnesses/skill-listing/codex-allocation.js";
import {
  codexListingResult,
  largeListingEntries,
} from "../src/harnesses/skill-listing/contracts.js";
import {
  claudeEntry,
  claudeListingResult,
  type ClaudeListingSettings,
} from "../src/harnesses/skill-listing/claude.js";

const settings: ClaudeListingSettings = {
  model: null,
  modelSource: "not configured",
  limit: null,
  limitSource: "Limit unverified",
  cap: 1536,
  overrides: {},
  notes: [],
};
test("shared Codex results preserve demand and allocation; list large contributors in either state", () => {
  for (const count of [1, 10]) {
    const skills = Array.from({ length: count }, (_, i) => ({
      name: `large-${i}`,
      description: "x".repeat(800),
      path: `/skills/${i}/SKILL.md`,
      scope: "repo",
    }));
    const result = estimateCodexListing({
      cwd: "/work",
      model: "test",
      contextWindow: 50000,
      skills,
    });
    const budget = codexListingResult({
      skills,
      budget: result.budget,
      skillDemands: result.skills,
    });
    expect(budget._tag).toBe("Estimated");
    if (budget._tag !== "Estimated") throw new Error("Expected estimate");
    expect(budget.demand).toBe(result.budget.requested);
    expect(budget.fitted).toBe(result.budget.used);
    expect(largeListingEntries(budget)).toHaveLength(count);
    expect(budget.demand > budget.limit).toBe(count !== 1);
    const threshold = {
      ...budget,
      limit: 10000,
      entries: [
        { name: "exact", path: "/exact", demand: 100 },
        { name: "above", path: "/above", demand: 101 },
      ],
    };
    expect(largeListingEntries(threshold).map((e) => e.name)).toEqual(["above"]);
  }
});
test("Claude combines capped description/when_to_use, honors explicit and name-only policy, and counts Unicode characters", () => {
  expect(
    claudeEntry("hidden", "/hidden", { "disable-model-invocation": true }, "", settings),
  ).toBeUndefined();
  const entry = claudeEntry(
    "skill",
    "/skill",
    { description: "🐱".repeat(1530), when_to_use: "when requested" },
    "",
    settings,
  )!;
  expect(Array.from(entry.description)).toHaveLength(1536);
  for (const mode of ["off", "user-invocable-only"])
    expect(
      claudeEntry("skill", "/skill", { description: "visible" }, "", {
        ...settings,
        overrides: { skill: mode },
      }),
    ).toBeUndefined();
  expect(
    claudeEntry(
      "plugin:skill",
      "/plugin",
      { description: "visible" },
      "",
      { ...settings, overrides: { "plugin:skill": "off" } },
      undefined,
      true,
    )?.description,
  ).toBe("visible");
  const nameOnly = claudeEntry("skill", "/skill", { description: "large" }, "", {
    ...settings,
    overrides: { skill: "name-only" },
  })!;
  expect(nameOnly.description).toBe("");
  const budget = claudeListingResult("/work", [entry], settings, []);
  expect(budget._tag).toBe("DemandOnly");
  expect(largeListingEntries(budget)).toEqual([]);
  if (budget._tag !== "DemandOnly") throw new Error("Expected demand only");
  expect(budget.demand).toBe(1544);
  const duplicate = claudeListingResult(
    "/work",
    [entry, { ...entry, path: "/copy" }],
    settings,
    [],
  );
  expect(duplicate).toMatchObject({ _tag: "DemandOnly", demand: 1544 });
});
test("Claude fixed character limit bounds description drops instead of reusing prefix trimming", () => {
  const entries = [
    { name: "a", path: "/a", description: "x".repeat(90) },
    { name: "b", path: "/b", description: "x".repeat(10) },
    { name: "c", path: "/c", description: "x".repeat(10) },
  ];
  const budget = claudeListingResult("/work", entries, { ...settings, limit: 70 }, []);
  if (budget._tag !== "Estimated") throw new Error("Expected known limit");
  expect(budget.descriptionsDropped).toEqual({ min: 1, max: 3 });
  expect(budget.shortened).toBe(0);
  expect(budget.omitted).toBe(0);
  expect(budget.fitted).toBeNull();
});
