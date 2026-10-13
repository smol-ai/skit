import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  LibraryStore,
  makeCollectionId,
  makeProjectionId,
  makeSkillId,
  makeSkillVersionId,
  Digest,
  AbsoluteDevicePath,
} from "../src/index.js";
import {
  estimateCodexListingBudget,
  type CodexListingSkill,
} from "../src/harnesses/skill-listing/codex-allocation.js";
import {
  implicitInvocationAllowed,
  readLibraryCodexListingBudget,
  readLibraryCodexListingSnapshot,
} from "../src/harnesses/skill-listing/codex.js";
import { codexListingResult, ListingBudget } from "../src/harnesses/skill-listing/contracts.js";
import { Schema } from "effect";
import { NativeLibraryFixture, nativeLibraryLayer } from "./helpers/listing-fixture.js";

const skill = (name: string, description = "Review code."): CodexListingSkill => ({
  name,
  description,
  path: `/skills/${name}/SKILL.md`,
  scope: "user",
  collectionId: "collection-a",
});
const estimate = (
  skills: readonly CodexListingSkill[],
  contextWindow: number | null = 373_000,
  maxContextTokens?: number,
) =>
  estimateCodexListingBudget({
    cwd: "/work",
    model: "test-model",
    contextWindow,
    skills,
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
  });

test("counts UTF-8 budget units, keeps duplicate names as distinct entries and separates shared usage", () => {
  const a = skill("review", "Révision 🐱");
  const b = { ...a, path: "/other/review/SKILL.md", collectionId: "collection-b" };
  const other = {
    name: "foreign",
    description: "Foreign skill.",
    path: "/foreign/SKILL.md",
    scope: "system",
  };
  const result = estimate([a, b, other]);
  const expected = Math.ceil(
    Buffer.byteLength(`- review: Révision 🐱 (file: /skills/review/SKILL.md)\n`) / 4,
  );
  expect(result.limit).toBe(7_460);
  expect(result.collections.find((item) => item.collectionId === "collection-a")).toMatchObject({
    collectionId: "collection-a",
    skills: 1,
    used: expected,
    requested: expected,
  });
  expect(result.otherSkills).toBe(1);
  expect(result.collections).toHaveLength(2);
  expect(result.used).toBeGreaterThan(
    result.collections.reduce((sum, item) => sum + item.used, result.sharedOverhead),
  );
  expect(result.shortened).toBe(0);
});

test("shrinks descriptions fairly, then omits entries while accounting only for included rows", () => {
  const skills = [skill("a", "a".repeat(800)), skill("b", "b".repeat(800))];
  const shortened = estimate(skills, 373_000, 100);
  expect(shortened.used).toBeLessThanOrEqual(100);
  expect(shortened.requested).toBeGreaterThan(100);
  expect(shortened.shortened).toBe(2);
  expect(shortened.omitted).toBe(0);
  const each = estimate(
    skills.map((entry, index) => ({ ...entry, collectionId: `collection-${index}` })),
    373_000,
    100,
  );
  expect(Math.abs(each.collections[0]!.used - each.collections[1]!.used)).toBeLessThanOrEqual(1);
  const omitted = estimate(skills, 373_000, 12);
  expect(omitted.used).toBeLessThanOrEqual(12);
  expect(omitted.omitted).toBe(1);
  expect(omitted.collections[0]).toMatchObject({ skills: 2, omitted: 1 });
});

test("uses shared roots to reduce row costs while accounting for roots overhead", () => {
  const root = `/Users/${"long-directory".repeat(20)}/.agents/skills`;
  const skills = Array.from({ length: 15 }, (_, index) => ({
    ...skill(`s${index}`, "Review code."),
    path: `${root}/s${index}/SKILL.md`,
  }));
  const result = estimate(skills);
  const expectedRows = skills.reduce(
    (total, entry, index) =>
      total +
      Math.ceil(
        Buffer.byteLength(`- ${entry.name}: Review code. (file: r0/s${index}/SKILL.md)\n`) / 4,
      ),
    0,
  );
  expect(result.sharedOverhead).toBeGreaterThan(0);
  expect(result.collections[0]).toMatchObject({ requested: expectedRows, used: expectedRows });
  expect(result.requested).toBe(expectedRows + result.sharedOverhead);
  expect(result.used).toBe(result.requested);
  expect(result.omitted).toBe(0);
});

test("caps descriptions at 1024 Unicode characters including the ellipsis", () => {
  const boundary = estimate([skill("test", "🐱".repeat(1024))]);
  const capped = estimate([skill("test", "🐱".repeat(1025))]);
  const rowCost = (description: string) =>
    Math.ceil(Buffer.byteLength(`- test: ${description} (file: /skills/test/SKILL.md)\n`) / 4);
  expect(boundary.requested).toBe(rowCost("🐱".repeat(1024)));
  expect(capped.requested).toBe(rowCost("🐱".repeat(1021) + "..."));
  expect(capped.used).toBe(capped.requested);
});

test("applies character fallback and the explicit budget override ceiling", () => {
  const fallback = estimate([skill("test", "🐱")], null);
  expect(fallback.unit).toBe("characters");
  expect(fallback.limit).toBe(8_000);
  expect(fallback.used).toBe(Array.from("- test: 🐱 (file: /skills/test/SKILL.md)\n").length);
  expect(estimate([], null, 50_000)).toMatchObject({
    unit: "budget-tokens",
    limit: 10_000,
    used: 0,
  });
});

it.effect(
  "joins native discovery to canonical projections, excludes disabled and explicit-only skills, and refreshes policies",
  () =>
    Effect.gen(function* () {
      const f = yield* NativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const doc = join(f.root, "projection", "SKILL.md");
      const alias = join(f.root, "alias", "SKILL.md");
      const explicit = join(f.root, "explicit", "SKILL.md");
      yield* fs.makeDirectory(join(f.root, "projection"), { recursive: true });
      yield* fs.makeDirectory(join(f.root, "explicit", "agents"), { recursive: true });
      yield* fs.writeFileString(doc, "---\nname: review\ndescription: Review code.\n---\nReview.");
      yield* fs.symlink(join(f.root, "projection"), join(f.root, "alias"));
      yield* fs.writeFileString(explicit, "Explicit only.");
      const metadataPath = join(f.root, "explicit", "agents", "openai.yaml");
      yield* fs.writeFileString(metadataPath, "policy:\n  allow_implicit_invocation: false\n");
      const entries = [
        { ...skill("review"), path: doc, enabled: true },
        { ...skill("review"), path: alias, enabled: true },
        { ...skill("disabled"), path: "/missing/disabled/SKILL.md", enabled: false },
        { ...skill("explicit"), path: explicit, enabled: true },
      ];
      yield* fs.writeFileString(
        join(f.root, "app-server"),
        `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize') console.log(JSON.stringify({id:r.id,result:{}}));
 else if(r.method==='skills/list') console.log(JSON.stringify({id:r.id,result:{data:[{cwd:r.params.cwds[0],skills:${JSON.stringify(entries)},errors:[]}]}}));
 else if(r.method==='config/read') console.log(JSON.stringify({id:r.id,result:{config:{model:'gpt-6.1-sol',model_context_window:null,skills:null}}}));
 else if(r.method!=='initialized') process.exit(1);
});`,
      );
      yield* fs.makeDirectory(join(f.home, ".codex"));
      yield* fs.writeFileString(
        join(f.home, ".codex", "models_cache.json"),
        JSON.stringify({ models: [{ slug: "test-model", context_window: 100_000 }] }),
      );
      const store = yield* LibraryStore;
      const state = yield* store.load;
      const skillId = makeSkillId();
      const collectionId = makeCollectionId();
      const versionId = makeSkillVersionId();
      const stateWithProjection = {
        ...state,
        skills: [
          {
            skill_id: skillId,
            collection_id: collectionId,
            name: "review",
            path: ".",
            versions: [],
          },
        ],
        projections: [
          {
            projection_id: makeProjectionId(),
            skill_id: skillId,
            skill_version_id: versionId,
            target: "agents" as const,
            root: AbsoluteDevicePath.make(f.root),
            path: AbsoluteDevicePath.make(join(f.root, "projection")),
            expected_digest: Digest.make(`sha256:${"a".repeat(64)}`),
            status: "installed" as const,
            projected_at: "2026-10-06T00:00:00Z",
          },
        ],
      };
      const options = { cwd: f.root, home: f.home };
      const first = yield* readLibraryCodexListingBudget(
        stateWithProjection,
        options,
        process.execPath,
      );
      expect(first).toMatchObject({
        status: "estimated",
        contextWindow: 500_000,
        limit: 10_000,
        otherSkills: 0,
        collections: [{ collectionId, skills: 1 }],
      });
      const withRejectedSkill = yield* readLibraryCodexListingSnapshot(
        stateWithProjection,
        options,
        process.execPath,
        {
          cwd: f.root,
          skills: entries,
          errors: [
            { path: "/broken/SKILL.md", message: "missing YAML frontmatter delimited by ---" },
          ],
          config: { config: { model: "gpt-6.1-sol", model_context_window: null, skills: null } },
        },
      );
      expect(withRejectedSkill.budget).toEqual(first);
      const shared = yield* Schema.decodeUnknownEffect(ListingBudget)(
        codexListingResult(withRejectedSkill),
      );
      expect(shared).toMatchObject({
        _tag: "Estimated",
        warnings: ["Skipped skill /broken/SKILL.md: missing YAML frontmatter delimited by ---"],
      });
      yield* fs.writeFileString(metadataPath, "policy:\n  allow_implicit_invocation: true\n");
      const refreshed = yield* readLibraryCodexListingBudget(
        stateWithProjection,
        options,
        process.execPath,
      );
      expect(refreshed).toMatchObject({ status: "estimated", otherSkills: 1 });
      yield* fs.remove(join(f.home, ".codex", "models_cache.json"));
      const fallback = yield* readLibraryCodexListingBudget(
        stateWithProjection,
        options,
        process.execPath,
      );
      expect(fallback).toMatchObject({
        status: "estimated",
        unit: "budget-tokens",
        contextWindow: 500_000,
        limit: 10_000,
      });
      yield* fs.writeFileString(
        metadataPath,
        [
          "a: &a [1,2,3,4,5,6,7,8,9,10]",
          "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
          "c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
          "policy: {allow_implicit_invocation: true}",
        ].join("\n"),
      );
      const excessiveAliases = yield* readLibraryCodexListingBudget(
        stateWithProjection,
        options,
        process.execPath,
      );
      expect(excessiveAliases).toMatchObject({ status: "unavailable" });
      yield* fs.writeFileString(metadataPath, "policy: [invalid");
      const malformed = yield* readLibraryCodexListingBudget(
        stateWithProjection,
        options,
        process.execPath,
      );
      expect(malformed).toMatchObject({ status: "unavailable" });
      const skipped = yield* readLibraryCodexListingBudget(
        stateWithProjection,
        { ...options, overrideRoot: "/custom" },
        process.execPath,
      );
      expect(skipped.status).toBe("unavailable");
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      Effect.provide(nativeLibraryLayer),
    ),
);

it.effect("uses the model default unless configuration overrides the context window", () =>
  Effect.gen(function* () {
    const f = yield* NativeLibraryFixture;
    const store = yield* LibraryStore;
    const state = yield* store.load;
    for (const [configured, contextWindow, limit] of [
      [null, 500_000, 10_000],
      [1_000_000, 1_000_000, 20_000],
      [200_000, 200_000, 4_000],
    ] as const) {
      const snapshot = yield* readLibraryCodexListingSnapshot(
        state,
        { cwd: f.root, home: f.home },
        undefined,
        {
          cwd: f.root,
          skills: [],
          errors: [],
          config: {
            config: { model: "gpt-6.1-sol", model_context_window: configured, skills: null },
          },
        },
      );
      expect(snapshot.budget).toMatchObject({ status: "estimated", contextWindow, limit });
    }
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    Effect.provide(nativeLibraryLayer),
  ),
);

it.effect("reads the invocation policy from agents/openai.yaml only", () =>
  Effect.gen(function* () {
    const f = yield* NativeLibraryFixture;
    const fs = yield* FileSystem.FileSystem;
    const doc = join(f.root, "policy", "SKILL.md");
    yield* fs.makeDirectory(join(f.root, "policy", "agents"), { recursive: true });
    yield* fs.writeFileString(doc, "Policy.");
    yield* fs.writeFileString(
      join(f.root, "policy", "SKILL.json"),
      JSON.stringify({ policy: { allow_implicit_invocation: false } }),
    );
    expect(yield* implicitInvocationAllowed(doc)).toBe(true);
    yield* fs.writeFileString(
      join(f.root, "policy", "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
    );
    expect(yield* implicitInvocationAllowed(doc)).toBe(false);
  }).pipe(Effect.provide(nativeLibraryLayer)),
);
