import { describe, expect, it } from "vitest";
import { makeMachineId } from "../src/library/entity-ids.js";
import { observedImportUsesCollection } from "../src/library/observed-import.js";

describe("observed import ownership", () => {
  const cases = [
    {
      name: "selected well-known plain Skill",
      source: { kind: "well-known" as const, locator: { value: "https://skills.example" } },
      selection: { kind: "selected-skills" as const, names: ["review"] },
      profiles: ["plain-skill/v1" as const],
      expected: false,
    },
    {
      name: "well-known full tree",
      source: { kind: "well-known" as const, locator: { value: "https://skills.example" } },
      selection: { kind: "full-tree" as const },
      profiles: ["plain-skill/v1" as const],
      expected: true,
    },
    {
      name: "GitHub selected paths",
      source: {
        kind: "github" as const,
        owner: "example",
        repository: "skills",
        collection_root: "." as const,
      },
      selection: { kind: "selected-paths" as const, paths: ["skills/review"] },
      profiles: ["plain-skill/v1" as const],
      expected: true,
    },
    {
      name: "direct URL tree",
      source: { kind: "url" as const, url: { value: "https://skills.example/SKILL.md" } },
      selection: { kind: "full-tree" as const },
      profiles: ["plain-skill/v1" as const],
      expected: true,
    },
    {
      name: "Git selected paths",
      source: {
        kind: "git" as const,
        remote: { value: "https://git.example/skills.git" },
        collection_root: "." as const,
      },
      selection: { kind: "selected-paths" as const, paths: ["skills/review"] },
      profiles: ["plain-skill/v1" as const],
      expected: true,
    },
    {
      name: "archive tree",
      source: { kind: "archive" as const, url: { value: "https://skills.example/all.tgz" } },
      selection: { kind: "full-tree" as const },
      profiles: ["plain-skill/v1" as const],
      expected: true,
    },
    {
      name: "setup-discovered individual Skill",
      source: {
        kind: "local" as const,
        machine_id: makeMachineId(),
        path: { value: "/skills/review" },
      },
      selection: { kind: "full-tree" as const },
      profiles: ["plain-skill/v1" as const],
      standalone: true,
      expected: false,
    },
    {
      name: "local source tree",
      source: {
        kind: "local" as const,
        machine_id: makeMachineId(),
        path: { value: "/skills" },
      },
      selection: { kind: "full-tree" as const },
      profiles: ["plain-skill/v1" as const],
      expected: true,
    },
    {
      name: "declared SKIT member",
      source: { kind: "well-known" as const, locator: { value: "https://skills.example" } },
      selection: { kind: "selected-skills" as const, names: ["review"] },
      profiles: ["declared-skit-skill/v1" as const],
      expected: true,
    },
  ];

  for (const testCase of cases)
    it(testCase.name, () => {
      expect(
        observedImportUsesCollection({
          source: testCase.source,
          selection: testCase.selection,
          materializationProfiles: testCase.profiles,
          ...("standalone" in testCase ? { standalone: testCase.standalone } : {}),
        }),
      ).toBe(testCase.expected);
    });
});
