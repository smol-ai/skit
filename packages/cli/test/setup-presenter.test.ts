import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  makeCollectionId,
  makeProjectionId,
  makeSkillId,
  makeSkillVersionId,
} from "@smolai/skit-core";
import { renderContract, setupDiscoverySummary } from "../src/presentation/contract-presenters.js";
import { classifySetupOnboarding } from "../src/workflows/library/setup.js";
import { setupDiscoveredSkillChoices } from "../src/presentation/setup-skills.js";
import type { SetupSkillInstance } from "../src/workflows/library/setup-contract.js";

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
      observedHash: `sha256:${hash.repeat(64)}`,
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

it("omits managed Library projections while preserving unmanaged copies and orphaned markers", () => {
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
    projectionId: makeProjectionId(),
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
        kind: "retained",
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

it("models large discovery results as collapsed while retaining their Collections", () => {
  const names = Array.from({ length: 6 }, (_, index) => `skill-${index + 1}`);
  const summary = setupDiscoverySummary({
    instances: names.map((name) => ({ name, path: `/work/project/.agents/skills/${name}` })),
    locks: [
      {
        path: "/work/project/skills-lock.json",
        status: "valid",
        entries: names.map((name, index) => ({
          name,
          source: "example/collection",
          computedHash: `hash-${index + 1}`,
        })),
      },
    ],
  });

  expect(summary).toEqual({
    skills: {
      count: 6,
      locations: 6,
      expanded: false,
      items: names.map((name) => ({
        name,
        paths: [`/work/project/.agents/skills/${name}`],
      })),
    },
    lockFiles: [
      {
        directory: "/work/project",
        status: "valid",
        collections: [
          {
            source: "example/collection",
            skills: names.map((name, index) => ({
              name,
              computedHash: `hash-${index + 1}`,
            })),
            expanded: false,
          },
        ],
      },
    ],
  });
});

it("models small skills and Collections as expanded", () => {
  const summary = setupDiscoverySummary({
    instances: [
      { name: "review", path: "/work/project/.agents/skills/review" },
      { name: "review", path: "/home/.agents/skills/review" },
      { name: "write", path: "/work/project/.agents/skills/write" },
    ],
    locks: [
      {
        path: "/work/project/skills-lock.json",
        status: "valid",
        entries: [
          {
            name: "review",
            source: "example/collection",
            computedHash: "review-hash",
            skillFolderHash: "legacy-review-hash",
          },
          { name: "write", source: "example/collection", computedHash: "write-hash" },
        ],
      },
    ],
  });

  expect(summary.skills).toMatchObject({ count: 2, locations: 3, expanded: true });
  expect(summary.skills.items).toEqual([
    {
      name: "review",
      paths: ["/home/.agents/skills/review", "/work/project/.agents/skills/review"],
    },
    { name: "write", paths: ["/work/project/.agents/skills/write"] },
  ]);
  expect(summary.lockFiles[0]?.collections).toEqual([
    {
      source: "example/collection",
      skills: [
        {
          name: "review",
          computedHash: "review-hash",
          skillFolderHash: "legacy-review-hash",
        },
        { name: "write", computedHash: "write-hash" },
      ],
      expanded: true,
    },
  ]);
});

it("separates installed, repository-authored, and loose skills", () => {
  const managedCollectionId = makeCollectionId();
  const managedSkillId = makeSkillId();
  const managedSkillVersionId = makeSkillVersionId();
  const output = renderContract(
    "skit.setup.v6",
    {
      machineConfig: {
        path: "/home/.skit/machine.json",
        repositoryRoots: ["/work"],
        persisted: false,
      },
      probes: [],
      scan: { complete: true, directoriesExamined: 3, repositorySearchDepth: 1 },
      repositories: [
        { path: "/work/large-collection", skills: ["review", "write", "edit"] },
        { path: "/work/single-skill", skills: ["local-only"] },
      ],
      repositoryConfigs: [],
      authoredCollections: [],
      projections: [
        {
          collectionId: managedCollectionId,
          collectionDisplayName: "Managed tools",
          skillId: managedSkillId,
          name: "already-there",
          path: "/home/.agents/skills/already-there",
          harnesses: ["codex"],
          status: "current",
        },
      ],
      onboarding: { planId: `sha256:${"0".repeat(64)}`, candidates: [] },
      locks: [],
      instances: [
        {
          name: "review",
          path: "/work/large-collection/.agents/skills/review",
          aliases: ["/work/large-collection/.agents/skills/review"],
          scope: "project",
          harnesses: ["codex"],
          owner: { kind: "unknown" },
          contentIdentity: { status: "none", libraryMatches: [] },
          git: { status: "committed", repository: "/work/large-collection" },
          locks: [
            {
              scope: "project",
              lockPath: "/work/large-collection/skills-lock.json",
              content: "agrees",
              entry: {
                name: "review",
                source: "mattpocock/skills",
                sourceType: "github",
                originalEntry: { source: "mattpocock/skills", sourceType: "github" },
              },
            },
          ],
        },
        {
          name: "write",
          path: "/work/large-collection/.agents/skills/write",
          aliases: ["/work/large-collection/.agents/skills/write"],
          scope: "project",
          harnesses: ["claude-code"],
          owner: { kind: "unknown" },
          contentIdentity: {
            status: "none",
            observedHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            libraryMatches: [],
          },
          git: { status: "ignored", repository: "/work/large-collection" },
          locks: [],
        },
        {
          name: "edit",
          path: "/work/large-collection/.agents/skills/edit",
          aliases: ["/work/large-collection/.agents/skills/edit"],
          scope: "project",
          harnesses: ["codex"],
          owner: { kind: "unknown" },
          contentIdentity: {
            status: "none",
            observedHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            libraryMatches: [],
          },
          git: { status: "committed", repository: "/work/large-collection" },
          locks: [],
        },
        {
          name: "local-only",
          path: "/work/single-skill/.agents/skills/local-only",
          aliases: ["/work/single-skill/.agents/skills/local-only"],
          scope: "project",
          harnesses: ["codex"],
          owner: { kind: "unknown" },
          contentIdentity: {
            status: "exact",
            observedHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            libraryMatches: [
              {
                collectionId: makeCollectionId(),
                skillId: makeSkillId(),
                skillVersionId: makeSkillVersionId(),
                name: "already-there",
              },
            ],
          },
          git: { status: "committed", repository: "/work/single-skill" },
          locks: [],
        },
        {
          name: "find-skills",
          path: "/home/.agents/skills/find-skills",
          aliases: ["/home/.agents/skills/find-skills"],
          scope: "global",
          harnesses: ["codex"],
          owner: { kind: "unknown" },
          contentIdentity: { status: "none", libraryMatches: [] },
          git: { status: "outside-git" },
          locks: [
            {
              scope: "global",
              lockPath: "/home/.agents/.skill-lock.json",
              content: "unverifiable",
              entry: {
                name: "find-skills",
                source: "vercel-labs/skills",
                sourceType: "github",
                originalEntry: { source: "vercel-labs/skills", sourceType: "github" },
              },
            },
          ],
        },
        {
          name: "already-there",
          path: "/home/.agents/skills/already-there",
          aliases: ["/home/.agents/skills/already-there"],
          scope: "global",
          harnesses: ["codex"],
          owner: {
            kind: "skit",
            membership: {
              kind: "retained",
              projectionId: makeProjectionId(),
              collectionId: managedCollectionId,
              skillId: managedSkillId,
              skillVersionId: managedSkillVersionId,
              displayName: "local:managed",
            },
          },
          contentIdentity: { status: "none", libraryMatches: [] },
          git: { status: "outside-git" },
          locks: [],
        },
      ],
      brokenLinks: [],
      suppressed: [],
    },
    { color: false, detail: "summary" },
  );

  expect(output).toContain("Skill collections");
  expect(output).toContain("Exact Library matches");
  expect(output).toContain("local-only · committed");
  expect(output).toContain("Equivalent unmanaged copies");
  expect(output).toContain("edit, write · 2 identical instances");
  expect(output).toContain("Installed collections");
  expect(output).toContain("mattpocock/skills · 1 skill");
  expect(output).toContain("mattpocock/skills · 1 skill\n    review");
  expect(output).toContain("vercel-labs/skills · 1 skill");
  expect(output).toContain("Repository collections (inferred)");
  expect(output).toContain("large-collection · .agents/skills · 2 skills");
  expect(output).toContain("large-collection · .agents/skills · 2 skills\n    edit, write");
  expect(output).toContain("Loose skills");
  expect(output).toContain("Loose skills\n  1 skill");
  expect(output).toContain("Loose skills\n  1 skill\n    local-only");
  expect(output).not.toContain("Loose skills\n  2 skills");
  expect(output).not.toContain("single-skill · .agents/skills");
  expect(output).toContain("Skill instances");
  expect(output).toContain("/work/large-collection/.agents/skills/review");
});

it("rolls up collections with more than five skill names", () => {
  const instances = Array.from({ length: 6 }, (_, index) => ({
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
    "skit.setup.v6",
    {
      machineConfig: {
        path: "/home/.skit/machine.json",
        repositoryRoots: ["/work"],
        persisted: false,
      },
      probes: [],
      scan: { complete: true, directoriesExamined: 1, repositorySearchDepth: 1 },
      repositories: [{ path: "/work/project", skills: instances.map((instance) => instance.name) }],
      repositoryConfigs: [],
      authoredCollections: [],
      projections: [],
      onboarding: { planId: `sha256:${"0".repeat(64)}`, candidates: [] },
      locks: [],
      instances,
      brokenLinks: [],
      suppressed: [],
    },
    { color: false, detail: "summary" },
  );

  expect(output).toContain("example/large-collection · 6 skills\n    6 committed");
  expect(output).not.toContain("example/large-collection · 6 skills\n    skill-1");
});

it("presents authored SKITs without treating their source skills as inferred collections", () => {
  const skitLocator = "skit:https://registry.test/tim/skills";
  const collectionId = makeCollectionId();
  const skillId = makeSkillId();
  const output = renderContract(
    "skit.setup.v6",
    {
      machineConfig: {
        path: "/home/.skit/machine.json",
        repositoryRoots: ["/work"],
        persisted: false,
      },
      probes: [],
      scan: { complete: true, directoriesExamined: 1, repositorySearchDepth: 1 },
      repositories: [{ path: "/work/skills", skills: ["council"] }],
      repositoryConfigs: [],
      authoredCollections: [
        {
          repository: "/work/skills",
          descriptorPath: "/work/skills/skit.json",
          remotePath: "/work/skills/skit.remote.json",
          skitLocator,
          origin: "https://registry.test",
          namespace: "tim",
          skit: "skills",
          collectionId,
          skills: [{ name: "council", path: "/work/skills/skills/council" }],
        },
      ],
      projections: [
        {
          collectionId,
          collectionDisplayName: "tim/skills",
          skillId,
          name: "council",
          path: "/home/.agents/skills/council",
          harnesses: ["codex"],
          status: "current",
        },
      ],
      onboarding: { planId: `sha256:${"0".repeat(64)}`, candidates: [] },
      locks: [],
      instances: [
        {
          name: "council",
          path: "/work/skills/skills/council",
          aliases: ["/work/skills/skills/council"],
          scope: "project",
          harnesses: [],
          owner: { kind: "authored", skitLocator, collectionId },
          contentIdentity: {
            status: "exact",
            observedHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            libraryMatches: [
              {
                collectionId: makeCollectionId(),
                skillId: makeSkillId(),
                skillVersionId: makeSkillVersionId(),
                name: "council",
              },
            ],
          },
          git: { status: "committed", repository: "/work/skills" },
          locks: [],
        },
      ],
      brokenLinks: [],
      suppressed: [],
    },
    { color: false, detail: "summary" },
  );

  expect(output).toContain("Authored SKITs");
  expect(output).toContain("tim/skills · /work/skills");
  expect(output).toContain("1 authored skill · library present · 1 current projection");
  expect(output).toContain("council · project · author-source · committed");
  expect(output).not.toContain("Repository collections (inferred)");
  expect(output).not.toContain("Existing SKIT projections");
});
