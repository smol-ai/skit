import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "@smolai/skit-core";
import { renderContract } from "../src/commands/output-presenters.js";
import { result } from "../src/commands/result.js";
import { classifySetupOnboarding, type SetupSkillInstance } from "@smolai/skit-core/library/setup";
import { setupDiscoveredSkillChoices } from "../src/library/setup/skills.js";

it("shows all physical copies, groups actual sources, and leaves conflicts and Codex unchecked", () => {
  const instance = (name: string, path: string, hash = "a"): SetupSkillInstance => ({
    name,
    path,
    aliases: [path],
    scope: "global",
    harnesses: ["codex"],
    owner: { kind: "unknown" },
    git: { status: "outside-git" },
    locks: [],
    contentIdentity: {
      status: "none",
      currentHash: `sha256:${hash.repeat(64)}`,
      libraryMatches: [],
    },
  });
  const home = "/home/test";
  const shared = {
    ...instance("align-me", `${home}/Work/skills/align-me`),
    harnesses: ["claude-code", "codex", "devin"] as const,
    aliases: [`${home}/.claude/skills/align-me`, `${home}/.codex/skills/align-me`],
  };
  const instances = [
    shared,
    instance("same", `${home}/.claude/skills/same`),
    instance("same", `${home}/.codex/skills/same`),
    {
      ...instance("different", `${home}/.claude/skills/different`),
      harnesses: ["claude-code"] as const,
    },
    instance("different", `${home}/.codex/skills/different`, "b"),
    {
      ...instance("invalid", `${home}/.claude/skills/invalid`),
      owner: { kind: "invalid-marker" } as const,
    },
    {
      ...instance("plugin", `${home}/.codex/plugins/cache/vendor/plugin`),
      owner: {
        kind: "harness",
        harness: "codex",
        source: "Codex curated",
        bundled: false,
      } as const,
    },
  ];
  const candidates = classifySetupOnboarding(instances);
  const rows = setupDiscoveredSkillChoices(instances, candidates, home);
  expect(rows).toHaveLength(instances.length);
  const choices = rows.map((row) => row.choice);
  expect(choices.find((item) => item.label === "align-me")).toMatchObject({
    group: "Local source · ~/Work/skills",
    selected: false,
  });
  expect(rows.find((row) => row.instance.name === "align-me")?.details).toContain(
    "Link: ~/.claude/skills/align-me → ~/Work/skills/align-me",
  );
  expect(
    choices.every((choice) => choice.description === undefined && choice.detail === undefined),
  ).toBe(true);
  const conflicting = choices.filter((item) => item.label === "different");
  expect(conflicting.map((item) => item.group)).toEqual([
    "Copies · different · global · choose one",
    "Copies · different · global · choose one",
  ]);
  expect(choices.slice(0, 2)).toEqual(conflicting);
  expect(
    choices
      .filter((item) => item.group === "Codex local skills · ~/.codex/skills")
      .every((item) => !item.selected),
  ).toBe(true);
  expect(
    choices
      .filter((item) => item.label === "different")
      .every((item) => !item.selected && item.selectExplicitly && !item.disabled),
  ).toBe(true);
  expect(rows.find((row) => row.instance.name === "different")?.details).toContain(
    "Space selects this copy",
  );
  expect(
    choices
      .filter((item) => item.label === "same")
      .every((item) => item.searchText?.includes("Duplicate content")),
  ).toBe(true);
  expect(choices.find((item) => item.label === "invalid")).toMatchObject({
    selected: false,
    disabled: true,
  });
  expect(choices.find((item) => item.label === "plugin")).toMatchObject({
    group: "Plugins · Codex curated",
    selected: false,
  });
  expect(new Set(choices.map((item) => item.value)).size).toBe(instances.length);
});

it("omits managed installed skills while preserving unmanaged copies and orphaned markers", () => {
  const unmanaged: SetupSkillInstance = {
    name: "review",
    path: "/home/.claude/skills/review",
    aliases: ["/home/.claude/skills/review"],
    scope: "global",
    harnesses: ["claude-code"],
    owner: { kind: "unknown" },
    git: { status: "outside-git" },
    locks: [],
    contentIdentity: { status: "none", libraryMatches: [] },
  };
  const membership = {
    installedSkillId: makeInstalledSkillId(),
    skillId: makeSkillId(),
    skillVersionId: makeSkillVersionId(),
  };
  const managed: SetupSkillInstance = {
    ...unmanaged,
    path: "/home/.codex/skills/review",
    aliases: ["/home/.codex/skills/review"],
    owner: {
      kind: "skit",
      membership: {
        ...membership,
        kind: "in-library",
        collectionId: makeCollectionId(),
        displayName: "review",
      },
    },
  };
  const orphaned: SetupSkillInstance = {
    ...unmanaged,
    name: "orphaned",
    path: "/home/.codex/skills/orphaned",
    owner: { kind: "skit", membership: { ...membership, kind: "missing-from-library" } },
  };
  const instances = [managed, unmanaged, orphaned];
  const rows = setupDiscoveredSkillChoices(instances, classifySetupOnboarding(instances));
  expect(rows.map((row) => row.instance.path)).toEqual([unmanaged.path, orphaned.path]);
  expect(rows.find((row) => row.instance === unmanaged)?.choice.selectExplicitly).toBe(true);
  expect(rows.find((row) => row.instance === orphaned)?.choice.disabled).toBe(true);
  expect(setupDiscoveredSkillChoices([managed], [])).toEqual([]);
});

it("rolls up collections with more than five skill names", () => {
  const instances = Array.from({ length: 6 }, (_, index): SetupSkillInstance => ({
    name: `skill-${index + 1}`,
    path: `/work/project/.agents/skills/skill-${index + 1}`,
    aliases: [`/work/project/.agents/skills/skill-${index + 1}`],
    scope: "project",
    harnesses: ["codex"],
    owner: { kind: "unknown" },
    contentIdentity: { status: "none", libraryMatches: [] },
    git: { status: "committed", repository: "/work/project" },
    locks: [
      {
        scope: "project",
        lockPath: "/work/project/skills-lock.json",
        lockVersion: 1,
        lockContentHash: `sha256:${"0".repeat(64)}`,
        content: "agrees",
        entry: {
          name: `skill-${index + 1}`,
          source: "example/large-collection",
          sourceType: "github",
          originalEntry: { source: "example/large-collection", sourceType: "github" },
        },
      },
    ],
  }));
  const output = renderContract(
    result("setup", {
      actions: [],
      choices: [],
      machineConfig: {
        path: "/home/.skit/machine.json",
        repositoryRoots: ["/work"],
        repositoryDecisions: [],
        persisted: false,
      },
      suggestedRepositoryRoots: [],
      probes: [],
      scan: { complete: true, directoriesExamined: 1, repositorySearchDepth: 1 },
      repositories: [
        {
          path: "/work/project",
          skills: instances.map((instance) => instance.name),
          status: "undecided",
        },
      ],
      repositoryConfigs: [],
      authoredCollections: [],
      installedSkills: [],
      collectionGroups: {
        sources: [{ source: "example/large-collection", instances }],
        repositories: [],
        loose: [],
        installed: [],
        authored: [],
      },
      onboarding: {
        planId: `sha256:${"0".repeat(64)}`,
        candidates: [],
        recommended: { sources: [], copies: [] },
      },
      locks: [],
      instances,
      brokenLinks: [],
      suppressed: [],
    }),
    { color: false, detail: "summary" },
  );

  expect(output).toContain("example/large-collection · 6 skills\n    6 committed");
  expect(output).not.toContain("example/large-collection · 6 skills\n    skill-1");
});
