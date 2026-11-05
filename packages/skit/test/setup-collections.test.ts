import { expect, it } from "vitest";
import {
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import type { SetupResult } from "../src/library/setup/contract.js";
import { setupCollectionGroups } from "../src/library/setup/collections.js";

it("separates installed, repository-authored, and loose skills", () => {
  const managedCollectionId = makeCollectionId();
  const managedSkillId = makeSkillId();
  const managedSkillVersionId = makeSkillVersionId();
  const data = {
    machineConfig: {
      path: "/home/.skit/machine.json",
      repositoryRoots: ["/work"],
      repositoryDecisions: [],
      persisted: false,
    },
    suggestedRepositoryRoots: [],
    probes: [],
    scan: { complete: true, directoriesExamined: 3, repositorySearchDepth: 1 },
    repositories: [
      {
        path: "/work/large-collection",
        skills: ["review", "write", "edit"],
        status: "undecided",
      },
      { path: "/work/single-skill", skills: ["local-only"], status: "undecided" },
    ],
    repositoryConfigs: [],
    authoredCollections: [],
    installedSkills: [
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
    onboarding: {
      planId: `sha256:${"0".repeat(64)}`,
      candidates: [],
      recommended: { sources: [], copies: [] },
    },
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
            lockVersion: 1,
            lockContentHash: `sha256:${"0".repeat(64)}`,
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
          currentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
          currentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
          currentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          libraryMatches: [
            {
              subjectId: makeCollectionId(),
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
            lockVersion: 1,
            lockContentHash: `sha256:${"0".repeat(64)}`,
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
            kind: "in-library",
            installedSkillId: makeInstalledSkillId(),
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
  } satisfies Omit<SetupResult, "collectionGroups">;
  const groups = setupCollectionGroups(data);
  expect(
    groups.sources.map((group) => [group.source, group.instances.map((instance) => instance.name)]),
  ).toEqual([
    ["mattpocock/skills", ["review"]],
    ["vercel-labs/skills", ["find-skills"]],
  ]);
  expect(
    groups.repositories.map((group) => [
      group.repository,
      group.root,
      group.instances.map((instance) => instance.name),
    ]),
  ).toEqual([
    ["/work/large-collection", "/work/large-collection/.agents/skills", ["write", "edit"]],
  ]);
  expect(groups.loose.map((instance) => instance.name)).toEqual(["local-only"]);
  expect(
    groups.installed.map((group) => [group.displayName, group.skills.map((skill) => skill.name)]),
  ).toEqual([["Managed tools", ["already-there"]]]);
  expect(groups.authored).toEqual([]);
});

it("presents authored SKITs without treating their source skills as inferred collections", () => {
  const skitLocator = "skit:https://registry.test/tim/skills";
  const collectionId = makeCollectionId();
  const skillId = makeSkillId();
  const data = {
    machineConfig: {
      path: "/home/.skit/machine.json",
      repositoryRoots: ["/work"],
      repositoryDecisions: [],
      persisted: false,
    },
    suggestedRepositoryRoots: [],
    probes: [],
    scan: { complete: true, directoriesExamined: 1, repositorySearchDepth: 1 },
    repositories: [{ path: "/work/skills", skills: ["council"], status: "undecided" }],
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
    installedSkills: [
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
    onboarding: {
      planId: `sha256:${"0".repeat(64)}`,
      candidates: [],
      recommended: { sources: [], copies: [] },
    },
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
          currentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          libraryMatches: [
            {
              subjectId: makeCollectionId(),
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
  } satisfies Omit<SetupResult, "collectionGroups">;
  const groups = setupCollectionGroups(data);
  expect(groups.repositories).toEqual([]);
  expect(groups.loose).toEqual([]);
  expect(groups.installed).toEqual([]);
  expect(groups.authored).toEqual([
    { ...data.authoredCollections[0], installedSkills: data.installedSkills },
  ]);
  // An unregistered authored workspace cannot claim unrelated ungrouped installed skills.
  const unregistered = setupCollectionGroups({
    ...data,
    authoredCollections: [{ ...data.authoredCollections[0], collectionId: undefined }],
    installedSkills: [{ ...data.installedSkills[0], collectionId: undefined }],
  });
  expect(unregistered.authored[0]?.installedSkills).toEqual([]);
  expect(unregistered.installed[0]?.skills).toEqual([
    { ...data.installedSkills[0], collectionId: undefined },
  ]);
});

it("groups installed copies by Collection identity, with independent loose Skill identities", () => {
  const collectionId = makeCollectionId();
  const firstSkill = makeSkillId();
  const secondSkill = makeSkillId();
  const copies = [
    { collectionId, skillId: firstSkill, path: "/agents/one", name: "one" },
    { collectionId, skillId: secondSkill, path: "/agents/two", name: "two" },
    { collectionId: makeCollectionId(), skillId: firstSkill, path: "/claude/one", name: "one" },
    { skillId: firstSkill, path: "/loose/one", name: "one" },
    { skillId: secondSkill, path: "/loose/two", name: "two" },
  ].map((copy) => ({
    ...copy,
    collectionDisplayName: "Same label",
    harnesses: [],
    status: "current" as const,
  }));
  const groups = setupCollectionGroups({
    instances: [],
    authoredCollections: [],
    installedSkills: copies,
  });
  expect(groups.installed).toHaveLength(4);
  expect(
    groups.installed
      .find((group) => group.skills.some((skill) => skill.path === "/agents/one"))
      ?.skills.map((skill) => skill.path),
  ).toEqual(["/agents/one", "/agents/two"]);
  expect(
    groups.installed
      .filter((group) => group.skills.length === 1)
      .map((group) => group.skills[0]?.path)
      .sort(),
  ).toEqual(["/claude/one", "/loose/one", "/loose/two"]);
});
