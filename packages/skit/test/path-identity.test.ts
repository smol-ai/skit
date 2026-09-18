import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { expect, test } from "vitest";
import { Effect, FileSystem } from "effect";
import {
  artifactUsesSymlinkEffect,
  groupProjectionTargetCandidatesEffect,
  observationPathIdentityEffect,
  pathIsWithin,
  projectionTargetPathIdentityEffect,
} from "../src/platform/path-identity.js";
import { skitLayer } from "../src/platform/layer.js";

const temporaryDirectory = (prefix: string) =>
  FileSystem.FileSystem.use((fs) => fs.makeTempDirectoryScoped({ prefix }));
const makeDirectory = (path: string) => FileSystem.FileSystem.use((fs) => fs.makeDirectory(path));
const symlink = (from: string, to: string) =>
  FileSystem.FileSystem.use((fs) => fs.symlink(from, to));
const exists = (path: string) => FileSystem.FileSystem.use((fs) => fs.exists(path));
const stat = (path: string) => FileSystem.FileSystem.use((fs) => fs.stat(path));

test("path containment distinguishes parent traversal from dot-prefixed child names", () => {
  expect(pathIsWithin("/work/repo", "/work/repo")).toBe(true);
  expect(pathIsWithin("/work/repo", "/work/repo/skills/demo")).toBe(true);
  expect(pathIsWithin("/work/repo", "/work/repo/..config/skills")).toBe(true);
  expect(pathIsWithin("/work/repo", "/work/sibling/skills")).toBe(false);
});

it.effect("one observation pass identifies symlink aliases as one physical path", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("skit-path-identity-");
    const target = join(root, "target");
    const alias = join(root, "alias");
    yield* makeDirectory(target);
    yield* symlink(target, alias);

    const direct = yield* observationPathIdentityEffect(target);
    const linked = yield* observationPathIdentityEffect(alias);
    expect(linked.canonicalPath).toBe(direct.canonicalPath);
    expect(linked.comparisonKey).toBe(direct.comparisonKey);
    expect(yield* artifactUsesSymlinkEffect(join(alias, "SKILL.md"))).toBe(true);
    expect(yield* artifactUsesSymlinkEffect(join(target, "SKILL.md"))).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("symlink provenance detects an artifact symlink inside a real Skill directory", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("skit-artifact-symlink-");
    const skill = join(root, "skill");
    const source = join(root, "source.md");
    const artifact = join(skill, "SKILL.md");
    yield* makeDirectory(skill);
    yield* symlink(source, artifact);

    expect(yield* artifactUsesSymlinkEffect(artifact)).toBe(true);
    expect(yield* artifactUsesSymlinkEffect(source)).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("canonical paths remain openable for decomposed on-disk names", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("skit-path-unicode-");
    const decomposed = join(root, "Cafe\u0301");
    const composed = join(root, "Caf\u00e9");
    yield* makeDirectory(decomposed);

    const observed = yield* observationPathIdentityEffect(decomposed);
    expect((yield* stat(observed.canonicalPath)).type).toBe("Directory");
    expect(observed.comparisonKey).toMatch(/^device:/);
    if (yield* exists(composed))
      expect((yield* observationPathIdentityEffect(composed)).comparisonKey).toBe(
        observed.comparisonKey,
      );
    else
      expect((yield* observationPathIdentityEffect(composed)).comparisonKey).not.toBe(
        observed.comparisonKey,
      );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "unresolved comparison fallback normalizes Unicode without changing its display path",
  () =>
    Effect.gen(function* () {
      const decomposed = join(tmpdir(), "Missing-Cafe\u0301");
      const composed = join(tmpdir(), "Missing-Caf\u00e9");
      expect((yield* observationPathIdentityEffect(decomposed)).canonicalPath).toBe(
        resolve(decomposed),
      );
      expect((yield* observationPathIdentityEffect(decomposed)).comparisonKey).toBe(
        (yield* observationPathIdentityEffect(composed)).comparisonKey,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a lone unresolved target has declared identity and may materialize", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("skit-target-unresolved-");
    const target = join(root, "future", "skills");

    const [group] = yield* groupProjectionTargetCandidatesEffect([target]);
    expect(group?.ambiguous).toBe(false);
    expect(group?.candidates[0]).toMatchObject({ declaredPath: resolve(target) });
    expect(group?.candidates[0]?.canonicalPath).toBeUndefined();
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("unresolved Unicode aliases form one ambiguity set", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("skit-target-alias-");
    const decomposed = join(root, "Cafe\u0301", "skills");
    const composed = join(root, "Caf\u00e9", "skills");

    const groups = yield* groupProjectionTargetCandidatesEffect([decomposed, composed]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ambiguous).toBe(true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("unresolved case aliases follow the containing filesystem", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("skit-target-case-");
    const upper = join(root, "Future", "Skills");
    const lower = join(root, "future", "skills");
    const rootName = basename(root);
    const toggledRoot = join(
      dirname(root),
      `${rootName[0] === rootName[0]?.toUpperCase() ? rootName[0]?.toLowerCase() : rootName[0]?.toUpperCase()}${rootName.slice(1)}`,
    );
    const caseInsensitive = yield* exists(toggledRoot);

    const groups = yield* groupProjectionTargetCandidatesEffect([upper, lower]);
    expect(groups).toHaveLength(caseInsensitive ? 1 : 2);
    if (caseInsensitive) expect(groups[0]?.ambiguous).toBe(true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("resolved target aliases retain declarations and share physical identity", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("skit-target-resolved-");
    const target = join(root, "target");
    const alias = join(root, "alias");
    yield* makeDirectory(target);
    yield* symlink(target, alias);

    const direct = yield* projectionTargetPathIdentityEffect(target);
    const linked = yield* projectionTargetPathIdentityEffect(alias);
    expect(linked.declaredPath).toBe(resolve(alias));
    expect(linked.canonicalPath).toBe(direct.canonicalPath);
    expect(linked.comparisonKey).toBe(direct.comparisonKey);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
