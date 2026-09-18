import { expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { Digest } from "@smolai/skit-core";
import {
  SourceSnapshotReader,
  SourceUnavailable,
  assessLockClaimPairing,
  checkLockClaims,
  pairLockClaims,
  type AgentSkillInstance,
  type SkillSource,
  type SkillsShLockCollectionClaim,
  type SourceSnapshot,
} from "../src/workflows/library/skills-sh-source-prototype.js";

const digest = (character: string) => Digest.make(`sha256:${character.repeat(64)}`);
const skillsHash = (character: string) => character.repeat(64);
const github: SkillSource = { kind: "github", owner: "acme", repo: "skills" };
const endpoint: SkillSource = { kind: "endpoint", url: "https://example.invalid" };
const instance = (
  name: string,
  scopeRoot: string,
  content: string,
  hash = content,
  localPath = `${scopeRoot}/${name}`,
): AgentSkillInstance => ({
  name,
  scopeRoot,
  localPath,
  contentDigest: digest(content),
  skillsShHash: skillsHash(hash),
});
const lock = (
  lockPath: string,
  scopeRoot: string,
  source: SkillSource,
  members: SkillsShLockCollectionClaim["members"],
): SkillsShLockCollectionClaim => ({ lockPath, scopeRoot, source, members });

it.effect(
  "fetches one Source for separate lock claims, while each disk copy has its own status",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const snapshot: SourceSnapshot = {
        source: github,
        observedAt: "2026-09-15T00:00:00Z",
        revision: "commit-b",
        members: [
          {
            name: "tdd",
            path: "skills/tdd/SKILL.md",
            contentDigest: digest("b"),
            skillsShHash: skillsHash("b"),
          },
        ],
      };
      const layer = Layer.succeed(
        SourceSnapshotReader,
        SourceSnapshotReader.of({
          fetch: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(snapshot)),
        }),
      );
      const checked = yield* checkLockClaims(
        [
          lock("/minima/skills-lock.json", "/minima", github, [
            {
              name: "tdd",
              claimedPath: "skills/tdd/SKILL.md",
              claimedSkillsShHash: skillsHash("a"),
            },
          ]),
          lock("/stackseer/skills-lock.json", "/stackseer", github, [
            { name: "tdd", claimedSkillsShHash: skillsHash("b") },
          ]),
        ],
        [instance("tdd", "/minima", "a"), instance("tdd", "/stackseer", "c")],
      ).pipe(Effect.provide(layer));
      expect(yield* Ref.get(calls)).toBe(1);
      expect(checked.contested).toEqual([]);
      expect(checked.checks[0]?.assessments[0]).toMatchObject({
        status: "upstream-ahead",
        resolution: { kind: "exact" },
      });
      expect(checked.checks[1]?.assessments[0]).toMatchObject({
        status: "locally-modified",
        resolution: { kind: "resolved-by-name" },
      });
    }),
);

it.effect(
  "keeps a disk Skill without lock evidence unclaimed and verifies an endpoint member",
  () =>
    Effect.gen(function* () {
      const snapshot: SourceSnapshot = {
        source: endpoint,
        observedAt: "2026-09-15T00:00:00Z",
        members: [
          {
            name: "analyze-logs",
            path: "/.well-known/agent-skills/analyze-logs",
            contentDigest: digest("a"),
            skillsShHash: skillsHash("f"),
          },
        ],
      };
      const layer = Layer.succeed(
        SourceSnapshotReader,
        SourceSnapshotReader.of({ fetch: () => Effect.succeed(snapshot) }),
      );
      const standalone = instance("unmanaged", "/fullres", "d");
      const checked = yield* checkLockClaims(
        [
          lock("/fullres/skills-lock.json", "/fullres", endpoint, [
            { name: "analyze-logs", claimedSkillsShHash: skillsHash("f") },
          ]),
        ],
        [instance("analyze-logs", "/fullres", "a", "f"), standalone],
      ).pipe(Effect.provide(layer));
      expect(checked.unclaimed).toEqual([standalone]);
      expect(checked.checks[0]?.assessments[0]).toMatchObject({
        status: "in-sync",
        resolution: { kind: "resolved-by-name" },
      });
    }),
);

it.effect("does not call a failed, mismatched, or hashless fetch verified", () =>
  Effect.gen(function* () {
    const claim = lock("/local/skills-lock.json", "/local", github, [
      { name: "tdd", claimedSkillsShHash: skillsHash("a") },
    ]);
    const disk = [instance("tdd", "/local", "a")];
    const unavailable = Layer.succeed(
      SourceSnapshotReader,
      SourceSnapshotReader.of({
        fetch: () => Effect.fail(new SourceUnavailable({ source: "acme/skills" })),
      }),
    );
    const failed = yield* checkLockClaims([claim], disk).pipe(Effect.provide(unavailable));
    expect(failed.checks[0]?.assessments[0]?.status).toBe("unverifiable");
    const snapshot: SourceSnapshot = {
      source: github,
      observedAt: "2026-09-15T00:00:00Z",
      members: [
        {
          name: "tdd",
          path: "skills/tdd/SKILL.md",
          contentDigest: digest("a"),
          skillsShHash: skillsHash("a"),
        },
      ],
    };
    const noHash = pairLockClaims([{ ...claim, members: [{ name: "tdd" }] }], disk);
    expect(assessLockClaimPairing(noHash.paired[0]!, snapshot)[0]?.status).toBe("unverifiable");
    const wrongSource = Layer.succeed(
      SourceSnapshotReader,
      SourceSnapshotReader.of({ fetch: () => Effect.succeed({ ...snapshot, source: endpoint }) }),
    );
    const mismatched = yield* checkLockClaims([claim], disk).pipe(Effect.provide(wrongSource));
    expect(mismatched.checks[0]?.assessments[0]?.status).toBe("unverifiable");
  }),
);

it.effect("separates ambiguous, orphaned, divergent, and stale-lock states", () =>
  Effect.sync(() => {
    const claim = lock("/local/skills-lock.json", "/local", github, [
      { name: "duplicate", claimedSkillsShHash: skillsHash("a") },
      {
        name: "removed",
        claimedPath: "skills/removed/SKILL.md",
        claimedSkillsShHash: skillsHash("a"),
      },
      {
        name: "diverged",
        claimedPath: "skills/diverged/SKILL.md",
        claimedSkillsShHash: skillsHash("a"),
      },
      { name: "stale", claimedPath: "skills/stale/SKILL.md", claimedSkillsShHash: skillsHash("a") },
    ]);
    const snapshot: SourceSnapshot = {
      source: github,
      observedAt: "2026-09-15T00:00:00Z",
      members: [
        {
          name: "duplicate",
          path: "one/SKILL.md",
          contentDigest: digest("a"),
          skillsShHash: skillsHash("a"),
        },
        {
          name: "duplicate",
          path: "two/SKILL.md",
          contentDigest: digest("a"),
          skillsShHash: skillsHash("a"),
        },
        {
          name: "diverged",
          path: "skills/diverged/SKILL.md",
          contentDigest: digest("c"),
          skillsShHash: skillsHash("c"),
        },
        {
          name: "stale",
          path: "skills/stale/SKILL.md",
          contentDigest: digest("b"),
          skillsShHash: skillsHash("b"),
        },
      ],
    };
    const paired = pairLockClaims(
      [claim],
      [
        instance("duplicate", "/local", "a"),
        instance("removed", "/local", "a"),
        instance("diverged", "/local", "b"),
        instance("stale", "/local", "b"),
      ],
    );
    expect(assessLockClaimPairing(paired.paired[0]!, snapshot).map((item) => item.status)).toEqual([
      "ambiguous",
      "orphaned",
      "diverged",
      "lock-stale",
    ]);
  }),
);

it.effect(
  "holds competing and duplicate disk claims contested, and conflicting hashes terminal",
  () =>
    Effect.sync(() => {
      const first = lock("/local/skills-lock.json", "/local", github, [
        { name: "tdd", claimedSkillsShHash: skillsHash("a") },
        { name: "repeated", claimedSkillsShHash: skillsHash("a") },
        { name: "repeated", claimedSkillsShHash: skillsHash("a") },
        { name: "conflict", claimedSkillsShHash: skillsHash("a") },
      ]);
      const second = lock("/local/other-lock.json", "/local", endpoint, [
        { name: "tdd", claimedSkillsShHash: skillsHash("a") },
      ]);
      const disk = [
        instance("tdd", "/local", "a"),
        instance("repeated", "/local", "a"),
        instance("conflict", "/local", "a"),
      ];
      const pairing = pairLockClaims([first, second], disk);
      expect(pairing.contested.map((item) => item.instance.name)).toEqual(["tdd", "repeated"]);
      expect(pairing.paired[0]?.members.map((item) => item.kind)).toEqual([
        "contested",
        "contested",
        "contested",
        "paired",
      ]);
      const snapshot: SourceSnapshot = {
        source: github,
        observedAt: "2026-09-15T00:00:00Z",
        members: [
          {
            name: "tdd",
            path: "tdd/SKILL.md",
            contentDigest: digest("a"),
            skillsShHash: skillsHash("a"),
          },
          {
            name: "repeated",
            path: "repeated/SKILL.md",
            contentDigest: digest("a"),
            skillsShHash: skillsHash("a"),
          },
          {
            name: "conflict",
            path: "conflict/SKILL.md",
            contentDigest: digest("b"),
            skillsShHash: skillsHash("a"),
          },
        ],
      };
      expect(
        assessLockClaimPairing(pairing.paired[0]!, snapshot).map((item) => item.status),
      ).toEqual(["contested", "contested", "contested", "evidence-conflict"]);
      const duplicates = pairLockClaims([first, first], disk);
      expect(duplicates.paired[0]?.members.every((member) => member.kind === "contested")).toBe(
        true,
      );
    }),
);
