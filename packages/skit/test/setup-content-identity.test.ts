import { expect, it } from "vitest";
import { Schema } from "effect";
import { SetupSkillInstance } from "../src/library/setup/contract.js";
import { TreeError } from "../src/shared/tree-error.js";
import { it as effectIt } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { testPlatformLayer } from "./helpers/platform.js";
import { collectSetupEvidence } from "../src/library/setup/discovery.js";
import { scanSetupCopies } from "../src/library/setup/copies.js";
import { classifySetupOnboarding } from "../src/library/setup/onboarding.js";
import { recommendedSetupSelection } from "../src/library/setup/decisions.js";
import { Revision } from "../src/library/snapshot.js";

const Content = SetupSkillInstance.fields.contentIdentity;

it("requires a hash for successful content and an error for failed content", () => {
  const valid = Schema.is(Content);
  expect(valid({ status: "hashed", libraryMatches: [] })).toBe(false);
  expect(valid({ status: "failed" })).toBe(false);
  expect(valid({ status: "exact", libraryMatches: [] })).toBe(false);
  expect(
    valid({ status: "hashed", currentHash: `sha256:${"a".repeat(64)}`, libraryMatches: [] }),
  ).toBe(true);
});

it("round-trips the concrete read failure instead of replacing it with a status", () => {
  const failure = new TreeError({ reason: { _tag: "InvalidSymlink", path: "copy.md" } });
  const value = { status: "failed" as const, failure };
  const encoded = Schema.encodeSync(Schema.toCodecJson(Content))(value);
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(Content))(encoded)).toEqual(value);
});

effectIt.effect("blocks an import when a copy changes after discovery and cannot be hashed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "skit-content-state-" });
    const root = yield* fs.realPath(temporary);
    const codex = join(root, "codex");
    const claude = join(root, "claude");
    const document = "---\nname: review\ndescription: Review fixture\n---\n\nReview bytes\n";
    for (const directory of [codex, claude]) {
      yield* fs.makeDirectory(join(directory, "review"), { recursive: true });
      yield* fs.writeFileString(join(directory, "review", "SKILL.md"), document);
    }
    const state = join(root, "state");
    yield* fs.makeDirectory(join(state, "skills"), { recursive: true });
    yield* fs.writeFileString(
      join(state, "skills", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          review: {
            source: "acme/skills",
            sourceType: "github",
            skillPath: "skills/review/SKILL.md",
          },
        },
      }),
    );
    const evidence = yield* collectSetupEvidence(
      { read: Effect.succeed({ _tag: "Absent", revision: Revision.make("absent") }) },
      {
        libraryHome: join(root, "library"),
        repositoryRoots: [],
        persistRoots: false,
        probePath: "",
        skillsStateHome: state,
        inventory: {
          home: root,
          configHome: join(root, "config"),
          overrides: { codex: [codex], "claude-code": [claude] },
        },
      },
    );
    const bad = join(claude, "review");
    yield* fs.symlink("SKILL.md", join(bad, "copy.md"));
    const copies = yield* scanSetupCopies(evidence, root, "");
    expect(copies.instances.find((copy) => copy.path === bad)?.contentIdentity).toMatchObject({
      status: "failed",
      failure: { _tag: "TreeError", reason: { _tag: "InvalidSymlink", path: "copy.md" } },
    });
    expect(
      copies.instances.find((copy) => copy.path === join(codex, "review"))?.contentIdentity.status,
    ).toBe("hashed");
    const candidates = classifySetupOnboarding(copies.onboardingInstances);
    expect(candidates).toEqual([
      expect.objectContaining({ action: "blocked", reason: "content-unhashable" }),
    ]);
    expect(recommendedSetupSelection(copies.onboardingInstances, candidates, root).sources).toEqual(
      [],
    );
  }).pipe(Effect.provide(testPlatformLayer)),
);
