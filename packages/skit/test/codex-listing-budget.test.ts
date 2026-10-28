import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  LibraryStore,
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
  Digest,
  AbsoluteDevicePath,
} from "../src/index.js";
import {
  estimateCodexListing,
  type CodexListingSkill,
} from "../src/harnesses/skill-listing/codex-allocation.js";
import {
  implicitInvocationAllowed,
  readCodexListingBudget,
} from "../src/harnesses/skill-listing/codex.js";
import { ListingBudget } from "../src/harnesses/skill-listing/contracts.js";
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
  estimateCodexListing({
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
    demand: expected,
  });
  expect(result.entries).toHaveLength(3);
  expect(result.collections).toHaveLength(2);
  expect(result.collections.reduce((sum, item) => sum + item.skills, 0)).toBe(2);
  expect(result.fitted).toBeGreaterThan(
    result.collections.reduce((sum, item) => sum + item.demand, 0),
  );
  expect(result.shortened).toBe(0);
});

test("shrinks descriptions fairly, then omits entries while accounting only for included rows", () => {
  const skills = [skill("a", "a".repeat(800)), skill("b", "b".repeat(800))];
  const shortened = estimate(skills, 373_000, 100);
  expect(shortened.fitted).toBeLessThanOrEqual(100);
  expect(shortened.demand).toBeGreaterThan(100);
  expect(shortened.shortened).toBe(2);
  expect(shortened.omitted).toBe(0);
  const omitted = estimate(skills, 373_000, 12);
  expect(omitted.fitted).toBeLessThanOrEqual(12);
  expect(omitted.omitted).toBe(1);
  expect(omitted.collections[0]).toMatchObject({ skills: 2 });
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
  expect(result.collections[0]).toMatchObject({ demand: expectedRows });
  // The roots table is shared overhead, counted once beyond the rows.
  expect(result.demand).toBeGreaterThan(expectedRows);
  expect(result.fitted).toBe(result.demand);
  expect(result.omitted).toBe(0);
});

test("caps descriptions at 1024 Unicode characters including the ellipsis", () => {
  const boundary = estimate([skill("test", "🐱".repeat(1024))]);
  const capped = estimate([skill("test", "🐱".repeat(1025))]);
  const rowCost = (description: string) =>
    Math.ceil(Buffer.byteLength(`- test: ${description} (file: /skills/test/SKILL.md)\n`) / 4);
  expect(boundary.demand).toBe(rowCost("🐱".repeat(1024)));
  expect(capped.demand).toBe(rowCost("🐱".repeat(1021) + "..."));
  expect(capped.fitted).toBe(capped.demand);
});

test("applies character fallback and the explicit budget override ceiling", () => {
  const fallback = estimate([skill("test", "🐱")], null);
  expect(fallback.unit).toBe("characters");
  expect(fallback.limit).toBe(8_000);
  expect(fallback.fitted).toBe(Array.from("- test: 🐱 (file: /skills/test/SKILL.md)\n").length);
  expect(estimate([], null, 50_000)).toMatchObject({
    unit: "budget-tokens",
    limit: 10_000,
    fitted: 0,
  });
});

it.effect(
  "joins native discovery to canonical installed skills, excludes disabled and explicit-only skills, and refreshes policies",
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
      const stateWithInstalledSkill = {
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
        installed_skills: [
          {
            installed_skill_id: makeInstalledSkillId(),
            skill_id: skillId,
            skill_version_id: versionId,
            destination: "agents" as const,
            root: AbsoluteDevicePath.make(f.root),
            path: AbsoluteDevicePath.make(join(f.root, "projection")),
            expected_digest: Digest.make(`sha256:${"a".repeat(64)}`),
            status: "installed" as const,
            installed_at: "2026-10-06T00:00:00Z",
          },
        ],
      };
      const options = { cwd: f.root };
      const first = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        options,
        process.execPath,
      );
      expect(first).toMatchObject({
        _tag: "Estimated",
        limit: 10_000,
        entries: [{ name: "review" }],
        collections: [{ collectionId, skills: 1 }],
      });
      const withRejectedSkill = yield* readCodexListingBudget(
        stateWithInstalledSkill,
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
      const warnings = [
        "Skipped skill /broken/SKILL.md: missing YAML frontmatter delimited by ---",
      ];
      expect(withRejectedSkill).toEqual({ ...first, warnings });
      expect(yield* Schema.decodeUnknownEffect(ListingBudget)(withRejectedSkill)).toMatchObject({
        _tag: "Estimated",
        warnings,
      });
      yield* fs.writeFileString(metadataPath, "policy:\n  allow_implicit_invocation: true\n");
      const refreshed = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        options,
        process.execPath,
      );
      expect(refreshed).toMatchObject({
        _tag: "Estimated",
        entries: [{ name: "explicit" }, { name: "review" }],
      });
      yield* fs.remove(join(f.home, ".codex", "models_cache.json"));
      const fallback = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        options,
        process.execPath,
      );
      expect(fallback).toMatchObject({
        _tag: "Estimated",
        unit: "budget-tokens",
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
      // The invocation adapter reads the one field without expanding aliases elsewhere.
      const excessiveAliases = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        options,
        process.execPath,
      );
      expect(excessiveAliases).toMatchObject({ _tag: "Estimated" });
      yield* fs.writeFileString(
        metadataPath,
        "disabled: &off false\npolicy:\n  allow_implicit_invocation: *off\n",
      );
      const aliasedExplicit = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        options,
        process.execPath,
      );
      expect(aliasedExplicit).toMatchObject({ _tag: "Estimated", entries: [{ name: "review" }] });
      yield* fs.writeFileString(metadataPath, "policy: {allow_implicit_invocation: no-policy}\n");
      const unreadable = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        options,
        process.execPath,
      );
      expect(unreadable).toMatchObject({ _tag: "Unavailable" });
      for (const text of [
        "policy: *missing\n",
        "policy:\n  allow_implicit_invocation: *missing\n",
      ]) {
        yield* fs.writeFileString(metadataPath, text);
        expect(
          yield* readCodexListingBudget(stateWithInstalledSkill, options, process.execPath),
        ).toMatchObject({ _tag: "Unavailable" });
      }
      yield* fs.writeFileString(metadataPath, "policy: [invalid");
      const malformed = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        options,
        process.execPath,
      );
      expect(malformed).toMatchObject({ _tag: "Unavailable" });
      const skipped = yield* readCodexListingBudget(
        stateWithInstalledSkill,
        { ...options, overrides: { codex: ["/custom"] } },
        process.execPath,
      );
      expect(skipped._tag).toBe("Unavailable");
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
    // Codex lists within 2% of the context window: the model default is 500,000.
    for (const [configured, limit] of [
      [null, 10_000],
      [1_000_000, 20_000],
      [200_000, 4_000],
    ] as const) {
      const budget = yield* readCodexListingBudget(state, { cwd: f.root }, undefined, {
        cwd: f.root,
        skills: [],
        errors: [],
        config: {
          config: { model: "gpt-6.1-sol", model_context_window: configured, skills: null },
        },
      });
      expect(budget).toMatchObject({ _tag: "Estimated", limit });
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
