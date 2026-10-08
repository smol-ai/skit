import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { Effect, FileSystem, type Scope } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { assert, it } from "@effect/vitest";
import {
  assertArchivePaths,
  AGENT_SKILLS_NORMALIZATION_PROFILE,
  auditExtractedSourceEffect,
  parseSkitSourceEffect,
  sourceLocator,
  sourceLocatorProfiles,
  sourceInputWithVersionEffect,
  resolveSkitSourceEffect,
  normalizeObservedAgentSkillsEffect,
} from "../src/acquisition/sources.js";
import { deterministicTreeHashEffect, validateSkitDirectoryEffect } from "../src/artifact/skit.js";
import { skitLayer, type SkitServices } from "../src/platform/layer.js";
import { prepareObservedCollectionEffect } from "../src/library/observed-import.js";

const git = (cwd: string, ...args: string[]) =>
  Effect.sync(() => execFileSync("git", args, { cwd, encoding: "utf8" }).trim());
const scratch = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));
const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));
const writeText = (path: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));
/** A resolved Source whose workspace the surrounding test Scope releases. */
const resolve = (root: string) => resolveSkitSourceEffect(root);
const releaseHash = (root: string, context: "author" | "retain") =>
  validateSkitDirectoryEffect(root, context === "author" ? "draft" : "source", {
    assessmentContext: context,
  }).pipe(Effect.map((validated) => validated.identity.releaseContentHash));
const provide = <A, E>(effect: Effect.Effect<A, E, SkitServices | Scope.Scope>) =>
  effect.pipe(Effect.provide(skitLayer), Effect.scoped);

const gitLinkFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-git-plugin-links-");
  const repository = join(root, "repository");
  const content = "---\nname: review\ndescription: Review.\n---\n\nVerbatim Skill content.\n";
  for (const path of [".claude/skills/review", "outside"]) {
    const directory = path === "outside" ? join(root, path) : join(repository, path);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* writeText(join(directory, "SKILL.md"), content);
  }
  yield* fs.makeDirectory(join(repository, ".claude/skills/review/references"));
  yield* writeText(
    join(repository, ".claude/skills/review/references/guide.md"),
    "Supporting reference.\n",
  );
  yield* fs.makeDirectory(join(repository, "plugins/bundle/skills"), { recursive: true });
  const selectedPath = "plugins/bundle/skills/review";
  yield* fs.symlink("../../../.claude/skills/review", join(repository, selectedPath));
  yield* fs.symlink("../.claude", join(repository, "plugins/linked"));
  yield* fs.symlink(selectedPath, join(repository, "contained-chain"));
  yield* fs.symlink(join(root, "outside"), join(repository, "absolute-escape"));
  yield* fs.symlink("../../../../../../../../", join(repository, "relative-escape"));
  yield* fs.symlink("absolute-escape", join(repository, "escape-chain"));
  yield* fs.symlink("../absolute-escape", join(repository, "plugins/escape"));
  yield* fs.makeDirectory(join(root, "outside/skills/review"), { recursive: true });
  yield* writeText(join(root, "outside/skills/review/SKILL.md"), content);
  yield* fs.symlink("missing-target", join(repository, "dangling"));
  for (const path of ["example/skills/review", "example/plugins/bundle/skills/review"]) {
    yield* fs.makeDirectory(join(repository, path), { recursive: true });
    yield* writeText(join(repository, path, "SKILL.md"), content);
  }
  yield* git(repository, "init", "-q");
  yield* git(repository, "add", ".");
  yield* git(
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "plugin links",
  );
  const remote = join(root, "remote.git");
  yield* git(root, "clone", "--bare", "-q", repository, remote);
  return { remote: pathToFileURL(remote).href, selectedPath, content };
});

describe("source contracts", () => {
  it.effect("preserves normalized relative paths for explicit member selections", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-selected-path-normalization-");
      yield* fs.makeDirectory(join(root, "x"));
      yield* writeText(join(root, "x/SKILL.md"), "---\nname: review\ndescription: Review.\n---\n");
      for (const path of ["./x/SKILL.md", "x//SKILL.md"]) {
        const resolved = yield* resolveSkitSourceEffect(root, {
          verbatimOnly: true,
          agentSkillPaths: [path],
        });
        expect(resolved.observedSkillPaths).toEqual(["x"]);
      }
    }).pipe(provide),
  );
  it.effect(
    "retains selected Git directory links as Skill content through subpaths and member selections",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitLinkFixture;
        const selections = [
          { source: { subpath: fixture.selectedPath }, options: {}, path: "." },
          {
            source: { subpath: fixture.selectedPath, skillDirectories: ["."] },
            options: {},
            path: ".",
          },
          { source: { subpath: "plugins/linked/skills/review" }, options: {}, path: "." },
          {
            source: { skillDirectories: ["plugins/linked/skills/review"] },
            options: {},
            path: "plugins/linked/skills/review",
          },
          { source: { subpath: "contained-chain" }, options: {}, path: "." },
          {
            source: { skillDirectories: [fixture.selectedPath] },
            options: {},
            path: fixture.selectedPath,
          },
          {
            source: {},
            options: { agentSkillPaths: [`${fixture.selectedPath}/SKILL.md`] },
            path: fixture.selectedPath,
          },
        ];
        for (const selected of selections) {
          const source = { type: "git" as const, remote: fixture.remote, ...selected.source };
          const observed = yield* resolveSkitSourceEffect(source, {
            ...selected.options,
            verbatimOnly: true,
          });
          expect(observed.observedSkillPaths).toEqual([selected.path]);
          const sourcePath = join(observed.originalRoot, selected.path);
          const prepared = yield* prepareObservedCollectionEffect([
            {
              name: "review",
              sourcePath,
              relativePath: selected.path,
              observedHash: yield* deterministicTreeHashEffect(sourcePath),
            },
          ]);
          expect(yield* readText(join(prepared.staged, selected.path, "SKILL.md"))).toEqual(
            fixture.content,
          );
          expect(
            yield* readText(join(prepared.staged, selected.path, "references/guide.md")),
          ).toEqual("Supporting reference.\n");
          const normalized = yield* resolveSkitSourceEffect(source, selected.options);
          expect(yield* readText(join(normalized.root, "skills/review/SKILL.md"))).toEqual(
            fixture.content,
          );
          yield* releaseHash(normalized.root, "retain");
        }
      }).pipe(provide),
  );
  it.effect("rejects selected Git links escaping the checkout before discovery", () =>
    Effect.gen(function* () {
      const fixture = yield* gitLinkFixture;
      for (const path of [
        "absolute-escape",
        "relative-escape",
        "escape-chain",
        "plugins/escape/skills/review",
      ]) {
        for (const selection of [
          { source: { subpath: path }, options: {} },
          { source: { skillDirectories: [path] }, options: {} },
          {
            source: {},
            options: { agentSkillPaths: [`${path}/SKILL.md`], allowMissingAgentSkillPaths: true },
          },
        ]) {
          const error = yield* resolveSkitSourceEffect(
            { type: "git", remote: fixture.remote, ...selection.source },
            { ...selection.options, verbatimOnly: true },
          ).pipe(Effect.flip);
          assert.strictEqual(error._tag, "SourcePolicyViolation");
          assert.include(error.message, "outside the checkout");
        }
      }
    }).pipe(provide),
  );
  it.effect(
    "reports dangling Git selections clearly while preserving missing locked-member recovery",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitLinkFixture;
        const source = { type: "git" as const, remote: fixture.remote };
        const subpathError = yield* resolveSkitSourceEffect(
          { ...source, subpath: "dangling" },
          { verbatimOnly: true },
        ).pipe(Effect.flip);
        assert.strictEqual(subpathError._tag, "SourcePolicyViolation");
        assert.include(subpathError.message, "symlink target is unavailable: dangling");
        const memberError = yield* resolveSkitSourceEffect(
          { ...source, skillDirectories: ["dangling"] },
          { verbatimOnly: true },
        ).pipe(Effect.flip);
        assert.strictEqual(memberError._tag, "SourcePolicyViolation");
        assert.include(memberError.message, "Locked Skill path is missing");
        const recovered = yield* resolveSkitSourceEffect(source, {
          verbatimOnly: true,
          agentSkillPaths: ["dangling/SKILL.md", `${fixture.selectedPath}/SKILL.md`],
          allowMissingAgentSkillPaths: true,
        });
        expect(recovered.observedSkillPaths).toEqual([fixture.selectedPath]);
        expect(recovered.missingAgentSkillPaths).toEqual(["dangling/SKILL.md"]);
      }).pipe(provide),
  );
  it.effect("accepts confined Git targets when the workspace has a symlinked parent", () =>
    Effect.gen(function* () {
      const fixture = yield* gitLinkFixture;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-workspace-alias-");
      yield* fs.makeDirectory(join(root, "real"));
      const alias = join(root, "alias");
      yield* fs.symlink(join(root, "real"), alias);
      const resolved = yield* resolveSkitSourceEffect(
        { type: "git", remote: fixture.remote, subpath: fixture.selectedPath },
        { verbatimOnly: true },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempDirectoryScoped: (options) =>
            fs.makeTempDirectoryScoped({ ...options, directory: alias }),
        }),
      );
      expect(resolved.observedSkillPaths).toEqual(["."]);
      expect(yield* readText(join(resolved.originalRoot, "SKILL.md"))).toEqual(fixture.content);
    }).pipe(provide),
  );
  it.effect("applies root plugin exclusion relative to an explicitly selected Git subpath", () =>
    Effect.gen(function* () {
      const fixture = yield* gitLinkFixture;
      const selected = yield* resolveSkitSourceEffect(
        { type: "git", remote: fixture.remote, subpath: "example" },
        { verbatimOnly: true },
      );
      expect(selected.observedSkillPaths).toEqual(["skills/review"]);
    }).pipe(provide),
  );
  it.effect(
    "skips root plugin packaging while discovering standalone and nested plugin paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* scratch("skit-plugin-discovery-");
        for (const path of [
          "skills/review",
          "plugins/bundle/skills/review",
          "examples/plugins/demo",
        ]) {
          yield* fs.makeDirectory(join(root, path), { recursive: true });
          yield* writeText(
            join(root, path, "SKILL.md"),
            "---\nname: review\ndescription: Review.\n---\n",
          );
        }
        const discovered = yield* resolveSkitSourceEffect(root, { verbatimOnly: true });
        expect(discovered.observedSkillPaths?.toSorted()).toEqual([
          "examples/plugins/demo",
          "skills/review",
        ]);
      }).pipe(provide),
  );
  it.effect("allows an explicitly selected plugin Skill, including locked member paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-explicit-plugin-");
      const path = "plugins/bundle/skills/review";
      yield* fs.makeDirectory(join(root, path), { recursive: true });
      yield* writeText(
        join(root, path, "SKILL.md"),
        "---\nname: review\ndescription: Review.\n---\n",
      );
      const direct = yield* resolveSkitSourceEffect(join(root, path), { verbatimOnly: true });
      expect(direct.observedSkillPaths).toEqual(["."]);
      yield* fs.symlink(join(root, path), join(root, "selected-link"));
      const linked = yield* resolveSkitSourceEffect(join(root, "selected-link"), {
        verbatimOnly: true,
      });
      expect(linked.originalRoot).toEqual(yield* fs.realPath(join(root, path)));
      expect(linked.observedSkillPaths).toEqual(["."]);
      const locked = yield* resolveSkitSourceEffect(root, {
        verbatimOnly: true,
        agentSkillPaths: [`${path}/SKILL.md`],
      });
      expect(locked.observedSkillPaths).toEqual([path]);
    }).pipe(provide),
  );
  it.effect("does not fall back to plugin packaging when no standalone Skills exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-plugin-only-");
      yield* fs.makeDirectory(join(root, "plugins/bundle/skills/review"), { recursive: true });
      yield* writeText(
        join(root, "plugins/bundle/skills/review/SKILL.md"),
        "---\nname: review\ndescription: Review.\n---\n",
      );
      const error = yield* resolveSkitSourceEffect(root, { verbatimOnly: true }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "NoSkitDescriptorFound");
      assert.include(error.message, "target its directory explicitly");
    }).pipe(provide),
  );
  it.effect(
    "discovers skills in hidden agent directories while excluding Git metadata and directory symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* scratch("skit-hidden-skills-");
        const paths = [".claude/skills/asb-positioning", "dev-skills/doc-skills", ".git/ignored"];
        for (const path of paths) {
          yield* fs.makeDirectory(join(root, path), { recursive: true });
          yield* writeText(
            join(root, path, "SKILL.md"),
            "---\nname: review\ndescription: Review.\n---\n",
          );
        }
        yield* fs.symlink(
          join(root, "dev-skills/doc-skills"),
          join(root, ".claude/skills/dev-link"),
        );
        const discovered = yield* resolveSkitSourceEffect(root, { verbatimOnly: true });
        expect(discovered.observedSkillPaths?.toSorted()).toEqual([
          ".claude/skills/asb-positioning",
          "dev-skills/doc-skills",
        ]);
      }).pipe(provide),
  );
  it.effect("keeps locator priorities and aliases unambiguous", () =>
    Effect.sync(() => {
      const priorities = sourceLocatorProfiles.map((profile) => profile.priority);
      const aliases = sourceLocatorProfiles.flatMap((profile) => profile.aliases);
      expect(priorities).toEqual([...priorities].toSorted((left, right) => left - right));
      expect(new Set(priorities).size).toBe(priorities.length);
      expect(new Set(aliases).size).toBe(aliases.length);
    }),
  );
  it.effect("normalizes colliding Skill names independent of installation layout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-skill-name-collision-");
      const upstream = join(root, "upstream");
      const installed = join(root, "installed");
      const pairs = [
        { name: "foo_bar", upstream: "a/foo_bar", installed: "z/foo_bar" },
        { name: "foo-bar", upstream: "z/foo-bar", installed: "a/foo-bar" },
      ];
      for (const pair of pairs) {
        const text = `---\nname: ${pair.name}\ndescription: Test Skill.\n---\n\n# ${pair.name}\n`;
        for (const directory of [join(upstream, pair.upstream), join(installed, pair.installed)]) {
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* writeText(join(directory, "SKILL.md"), text);
        }
      }
      const acquired = yield* normalizeObservedAgentSkillsEffect(
        pairs.map((pair) => join(upstream, pair.upstream)),
        join(root, "acquired"),
        upstream,
      );
      const adopted = yield* normalizeObservedAgentSkillsEffect(
        pairs.map((pair) => join(installed, pair.installed)),
        join(root, "adopted"),
        installed,
      );
      expect(yield* deterministicTreeHashEffect(adopted.root)).toBe(
        yield* deterministicTreeHashEffect(acquired.root),
      );
    }).pipe(provide),
  );
  it.effect(
    "normalizes Agent Skills without laundering inferred capabilities into declarations",
    () =>
      Effect.gen(function* () {
        expect(AGENT_SKILLS_NORMALIZATION_PROFILE).toBe("agent-skills/v1");
        const root = yield* scratch("skit-agent-skill-evidence-");
        yield* writeText(
          join(root, "SKILL.md"),
          '---\nname: review\ndescription: Review.\n---\n\nCall spawn("bash", ["-c", command]).\n',
        );

        const resolved = yield* resolve(root);
        const readme = yield* readText(join(resolved.root, "README.md"));
        expect(readme).toContain("slug: internal-normalized");
        expect(readme).not.toContain("id: local/");
        expect(readme).not.toContain("capabilities:");
        expect(readme).not.toContain("mutation_scopes:");

        const validation = yield* validateSkitDirectoryEffect(resolved.root, "source", {
          assessmentContext: "retain",
        });
        expect(validation.diagnostics).toContainEqual(
          expect.objectContaining({ code: "SECURITY_ASSESSMENT_WARNING", severity: "warning" }),
        );
        expect(validation.diagnostics).not.toContainEqual(
          expect.objectContaining({ severity: "error" }),
        );
      }).pipe(provide),
  );

  it.effect("keeps generated declarations independent of detector-sensitive prose", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixedTime = new Date("2026-01-01T00:00:00.000Z");
      const makeSkill = Effect.fn("Test.makeSkill")(function* (body: string) {
        const root = yield* scratch("skit-agent-skill-profile-");
        const path = join(root, "SKILL.md");
        yield* fs.writeFileString(
          path,
          `---\nname: review\ndescription: Review.\n---\n\n${body}\n`,
        );
        yield* fs.utimes(path, fixedTime, fixedTime);
        return root;
      });
      const benignRoot = yield* makeSkill("Review subprocess boundaries.");
      const executableRoot = yield* makeSkill('Call spawn("bash", ["-c", command]).');
      const benign = yield* resolve(benignRoot);
      const executable = yield* resolve(executableRoot);
      expect(yield* readText(join(benign.root, "README.md"))).toBe(
        yield* readText(join(executable.root, "README.md")),
      );
      expect(yield* releaseHash(benign.root, "author")).not.toBe(
        yield* releaseHash(executable.root, "author"),
      );
    }).pipe(provide),
  );

  it.effect("wraps identical Agent Skill bytes deterministically", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-agent-skill-repeat-");
      yield* writeText(
        join(root, "SKILL.md"),
        "---\nname: review\ndescription: Review.\n---\n\n# Review\n",
      );
      const first = yield* resolve(root);
      const second = yield* resolve(root);
      expect(yield* readText(join(first.root, "README.md"))).toBe(
        yield* readText(join(second.root, "README.md")),
      );
      expect(yield* releaseHash(first.root, "author")).toBe(
        yield* releaseHash(second.root, "author"),
      );
    }).pipe(provide),
  );

  it.effect("resolves shorthand deterministically before acquisition", () =>
    Effect.gen(function* () {
      expect(yield* parseSkitSourceEffect("tim/dad-joke@1.0.0")).toEqual({
        type: "registry",
        namespace: "tim",
        slug: "dad-joke",
        version: "1.0.0",
      });
      expect(yield* parseSkitSourceEffect("humanlayer/skills")).toEqual({
        type: "github",
        owner: "humanlayer",
        repository: "skills",
      });
      expect(yield* sourceInputWithVersionEffect("humanlayer/skills", "1.2.0")).toBe(
        "skit:humanlayer/skills",
      );
      expect(yield* parseSkitSourceEffect("gh:humanlayer/skills")).toEqual({
        type: "github",
        owner: "humanlayer",
        repository: "skills",
      });
      expect(yield* parseSkitSourceEffect("skit:humanlayer/skills")).toEqual({
        type: "registry",
        namespace: "humanlayer",
        slug: "skills",
      });
      const canonical = yield* parseSkitSourceEffect(
        "skit://registry.example/humanlayer/skills@1.2.0",
      );
      expect(canonical).toEqual({
        type: "registry",
        namespace: "humanlayer",
        slug: "skills",
        version: "1.2.0",
        authority: "https://registry.example",
      });
      expect(sourceLocator(canonical)).toBe("skit://registry.example/humanlayer/skills@1.2.0");
      const loopback = yield* parseSkitSourceEffect(
        "skit+http://127.0.0.1:8787/humanlayer/skills@1.2.0",
      );
      expect(loopback).toEqual({
        type: "registry",
        namespace: "humanlayer",
        slug: "skills",
        version: "1.2.0",
        authority: "http://127.0.0.1:8787",
      });
      expect(sourceLocator(loopback)).toBe("skit+http://127.0.0.1:8787/humanlayer/skills@1.2.0");
    }).pipe(provide),
  );

  it.effect("prefers an existing local path over GitHub shorthand", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-local-shorthand-");
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(join(root, "humanlayer", "skills"), { recursive: true });
      expect(yield* sourceInputWithVersionEffect("humanlayer/skills", "1.2.0", root)).toBe(
        "humanlayer/skills",
      );
      expect(yield* parseSkitSourceEffect("humanlayer/skills", root)).toEqual({
        type: "local",
        path: join(root, "humanlayer", "skills"),
      });
    }).pipe(provide),
  );

  it.effect("parses GitHub repository and tree URLs into reproducible Git sources", () =>
    Effect.gen(function* () {
      for (const input of [
        "https://github.com/mattpocock/skills",
        "https://github.com/mattpocock/skills/",
        "https://github.com/mattpocock/skills.git",
      ])
        expect(yield* parseSkitSourceEffect(input)).toEqual({
          type: "github",
          owner: "mattpocock",
          repository: "skills",
        });
      for (const input of [
        "https://github.com/mattpocock/skills/tree/main/skills/code-review",
        "https://github.com/mattpocock/skills/tree/main/skills/code-review/",
      ])
        expect(yield* parseSkitSourceEffect(input)).toEqual({
          type: "github",
          owner: "mattpocock",
          repository: "skills",
          ref: "main",
          subpath: "skills/code-review",
        });
      expect(
        yield* parseSkitSourceEffect("https://github.com/mattpocock/skills/tree/v1.2.0"),
      ).toEqual({ type: "github", owner: "mattpocock", repository: "skills", ref: "v1.2.0" });
      expect(
        (yield* parseSkitSourceEffect(
          "https://github.com/mattpocock/skills/tree/main/skills/../../escape",
        ).pipe(Effect.flip))._tag,
      ).toBe("UnsafeGitSubpath");
      for (const input of [
        "https://github.com/mattpocock/skills#ref=main",
        "https://github.com/mattpocock/skills.git#skill=review%2FSKILL.md",
        "https://github.com/mattpocock/skills/tree/main/skills#top",
      ])
        expect((yield* parseSkitSourceEffect(input).pipe(Effect.flip))._tag).toBe(
          "GitSourceFragment",
        );
    }).pipe(provide),
  );

  it.effect("writes a GitHub ref or subpath as a tree URL that parses back to the Source", () =>
    Effect.gen(function* () {
      for (const source of [
        { type: "github" as const, owner: "acme", repository: "skills" },
        { type: "github" as const, owner: "acme", repository: "skills", ref: "v1.2.0" },
        {
          type: "github" as const,
          owner: "acme",
          repository: "skills",
          ref: "feature/review",
          subpath: "skills/review",
        },
      ])
        expect(yield* parseSkitSourceEffect(sourceLocator(source))).toEqual(source);
      expect(
        sourceLocator({
          type: "github",
          owner: "acme",
          repository: "skills",
          ref: "main",
          subpath: "skills",
        }),
      ).toBe("https://github.com/acme/skills/tree/main/skills");
    }).pipe(provide),
  );

  it.effect("reacquires only locked Git Skill paths without inventing a timestamp", () =>
    Effect.gen(function* () {
      const fixture = yield* scratch("skit-git-locked-members-");
      const fs = yield* FileSystem.FileSystem;
      for (const name of ["review", "other"]) {
        const directory = join(fixture, "skills", name);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* writeText(
          join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name} Skill.\n---\n\n# ${name}\n`,
        );
      }
      yield* git(fixture, "init", "-q");
      yield* git(
        fixture,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "add",
        ".",
      );
      yield* git(
        fixture,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "first",
      );
      const source = {
        type: "git" as const,
        remote: fixture,
        skillDirectories: ["skills/review"],
      };
      const first = yield* resolveSkitSourceEffect(source);
      const firstHash = yield* releaseHash(first.root, "retain");
      expect(yield* readText(join(first.root, "skills", "review", "SKILL.md"))).toContain(
        "# review",
      );
      expect(yield* fs.exists(join(first.root, "skills", "other"))).toBe(false);
      yield* writeText(
        join(fixture, "skills", "other", "SKILL.md"),
        "---\nname: other\ndescription: Other.\n---\n\nChanged unrelated Skill.\n",
      );
      yield* git(
        fixture,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "add",
        ".",
      );
      yield* git(
        fixture,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "second",
      );
      const second = yield* resolveSkitSourceEffect(source);
      expect(yield* releaseHash(second.root, "retain")).toBe(firstHash);
      expect(second.revision).not.toEqual(first.revision);
    }).pipe(provide),
  );

  it.effect("acquires discovery 0.2.0 artifacts and verifies their advertised digest", () =>
    Effect.gen(function* () {
      const base = "https://skills.example";
      const skill = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n";
      const digest = `sha256:${createHash("sha256").update(skill).digest("hex")}`;
      const index = JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "review",
            description: "Review code.",
            type: "skill-md",
            url: "/review/SKILL.md",
            digest,
          },
        ],
      });
      const client = (artifact: string) =>
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                request.url === `${base}/.well-known/agent-skills/index.json`
                  ? index
                  : request.url === `${base}/review/SKILL.md`
                    ? artifact
                    : "missing",
                {
                  status:
                    request.url === `${base}/.well-known/agent-skills/index.json` ||
                    request.url === `${base}/review/SKILL.md`
                      ? 200
                      : 404,
                },
              ),
            ),
          ),
        );
      expect(yield* parseSkitSourceEffect(`wellknown:${base}`)).toEqual({
        type: "well-known",
        origin: base,
      });
      expect(yield* parseSkitSourceEffect(base)).toEqual({
        type: "well-known",
        origin: base,
      });
      expect(yield* parseSkitSourceEffect(`${base}/`)).toEqual({
        type: "well-known",
        origin: base,
      });
      const resolved = yield* resolveSkitSourceEffect(base).pipe(
        Effect.provideService(HttpClient.HttpClient, client(skill)),
      );
      expect(resolved.source.type).toBe("well-known");
      expect(sourceLocator(resolved.source)).toBe(`wellknown:${base}`);
      expect(yield* readText(join(resolved.root, "skills", "review", "SKILL.md"))).toBe(skill);
      const failure = yield* resolveSkitSourceEffect(`wellknown:${base}`).pipe(
        Effect.provideService(HttpClient.HttpClient, client(`${skill}changed`)),
        Effect.flip,
      );
      expect(failure._tag).toBe("SourcePolicyViolation");
      if (failure._tag === "SourcePolicyViolation")
        expect(failure.reason).toMatchObject({ _tag: "PinMismatch" });
    }).pipe(provide),
  );

  it.effect("keeps HTTPS paths as direct document sources", () =>
    Effect.gen(function* () {
      expect(yield* parseSkitSourceEffect("https://skills.example/SKILL.md")).toEqual({
        type: "url",
        url: "https://skills.example/SKILL.md",
      });
      expect(yield* parseSkitSourceEffect("https://skills.example/catalog")).toEqual({
        type: "url",
        url: "https://skills.example/catalog",
      });
      for (const input of [
        "https://skills.example#skills=review",
        "https://skills.example?collection=review",
        "https://skills.example/#",
        "https://skills.example/?",
      ]) {
        const failure = yield* parseSkitSourceEffect(input).pipe(Effect.flip);
        expect(failure._tag).toBe("UnsafeSourceUrl");
      }
    }).pipe(provide),
  );

  it.effect("acquires legacy discovery file lists and observes changed upstream bytes", () =>
    Effect.gen(function* () {
      const base = "https://legacy.example";
      const index = JSON.stringify({
        skills: [
          {
            name: "review",
            description: "Review code.",
            files: ["SKILL.md", "references/guide.md"],
          },
        ],
      });
      const skill = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n";
      const client = (guide: string) =>
        HttpClient.make((request) => {
          const responses = new Map([
            [`${base}/.well-known/skills/index.json`, index],
            [`${base}/.well-known/skills/review/SKILL.md`, skill],
            [`${base}/.well-known/skills/review/references/guide.md`, guide],
          ]);
          const body = responses.get(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body ?? "missing", { status: body === undefined ? 404 : 200 }),
            ),
          );
        });
      const first = yield* resolveSkitSourceEffect(`wellknown:${base}`).pipe(
        Effect.provideService(HttpClient.HttpClient, client("first")),
      );
      const second = yield* resolveSkitSourceEffect(first.source).pipe(
        Effect.provideService(HttpClient.HttpClient, client("second")),
      );
      expect(yield* readText(join(first.root, "skills", "review", "references", "guide.md"))).toBe(
        "first",
      );
      expect(yield* readText(join(second.root, "skills", "review", "references", "guide.md"))).toBe(
        "second",
      );
      expect(yield* releaseHash(first.root, "retain")).not.toBe(
        yield* releaseHash(second.root, "retain"),
      );
    }).pipe(provide),
  );

  it.effect("acquires a selected 0.2.0 archive member without fetching other members", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-discovery-archive-");
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(join(root, "references"));
      const skill = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n";
      yield* writeText(join(root, "SKILL.md"), skill);
      yield* writeText(join(root, "references", "guide.md"), "Guide");
      const archive = yield* Effect.sync(() =>
        execFileSync("zip", ["-q", "-", "SKILL.md", "references/guide.md"], { cwd: root }),
      );
      const base = "https://archive.example";
      const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
      const index = JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "review",
            description: "Review code.",
            type: "archive",
            url: "/review.zip",
            digest,
          },
          {
            name: "other",
            description: "Other Skill.",
            type: "skill-md",
            url: "/other/SKILL.md",
            digest: "sha256:" + "0".repeat(64),
          },
        ],
      });
      const requested: string[] = [];
      const client = HttpClient.make((request) => {
        requested.push(request.url);
        const body = request.url.endsWith("/index.json")
          ? index
          : request.url.endsWith("/review.zip")
            ? archive
            : "missing";
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, { status: body === "missing" ? 404 : 200 }),
          ),
        );
      });
      const rejected = yield* parseSkitSourceEffect(`wellknown:${base}#skills=review`).pipe(
        Effect.flip,
      );
      expect(rejected._tag).toBe("UnsafeSourceUrl");
      const parsed = { type: "well-known" as const, origin: base, skillNames: ["review"] };
      expect(sourceLocator(parsed)).toBe(`wellknown:${base}`);
      const resolved = yield* resolveSkitSourceEffect(parsed).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(
        yield* readText(join(resolved.root, "skills", "review", "references", "guide.md")),
      ).toBe("Guide");
      expect(requested).not.toContain(`${base}/other/SKILL.md`);
    }).pipe(provide),
  );

  it.effect("rejects discovery archives containing links before extraction", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-discovery-link-");
      const fs = yield* FileSystem.FileSystem;
      yield* writeText(join(root, "SKILL.md"), "---\nname: review\ndescription: Review.\n---\n");
      yield* fs.symlink("/tmp", join(root, "escape"));
      yield* Effect.sync(() =>
        execFileSync("zip", ["-q", "-y", "review.zip", "SKILL.md", "escape"], { cwd: root }),
      );
      const archive = yield* fs.readFile(join(root, "review.zip"));
      const base = "https://archive.example";
      const index = JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "review",
            description: "Review.",
            type: "archive",
            url: "/review.zip",
            digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
          },
        ],
      });
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(request.url.endsWith("/index.json") ? index : Uint8Array.from(archive)),
          ),
        ),
      );
      const failure = yield* resolveSkitSourceEffect(`wellknown:${base}`).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(failure._tag).toBe("SourcePolicyViolation");
      if (failure._tag === "SourcePolicyViolation")
        expect(failure.reason).toMatchObject({ _tag: "InvalidSource" });
      expect(failure.message).toContain("contains a link");
    }).pipe(provide),
  );

  it.effect("reports a body that breaks mid-download as a transport failure", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"skills": ['));
                  controller.error(new Error("connection reset"));
                },
              }),
            ),
          ),
        ),
      );
      const failure = yield* resolveSkitSourceEffect("wellknown:https://reset.example").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(failure._tag).toBe("SourcePolicyViolation");
      if (failure._tag === "SourcePolicyViolation") expect(failure.reason._tag).toBe("Transport");
    }).pipe(provide),
  );

  it.effect("canonicalizes GitHub blob SKILL.md URLs to raw content", () =>
    Effect.gen(function* () {
      // A line anchor is not a Git fragment: the page URL is still a direct document.
      expect(
        yield* parseSkitSourceEffect(
          "https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/review/SKILL.md#L1",
        ),
      ).toEqual({
        type: "url",
        url: "https://raw.githubusercontent.com/cursor/plugins/main/cursor-team-kit/skills/review/SKILL.md#L1",
      });
      expect(
        yield* parseSkitSourceEffect(
          "https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/review/SKILL.md",
        ),
      ).toEqual({
        type: "url",
        url: "https://raw.githubusercontent.com/cursor/plugins/main/cursor-team-kit/skills/review/SKILL.md",
      });
      expect(
        yield* parseSkitSourceEffect(
          "https://raw.githubusercontent.com/cursor/plugins/refs/heads/main/cursor-team-kit/skills/review/SKILL.md",
        ),
      ).toEqual({
        type: "url",
        url: "https://raw.githubusercontent.com/cursor/plugins/main/cursor-team-kit/skills/review/SKILL.md",
      });
    }).pipe(provide),
  );

  it.effect("imports direct SKILL.md documents and rejects HTML masquerading as one", () =>
    Effect.gen(function* () {
      const url =
        "https://raw.githubusercontent.com/cursor/plugins/main/cursor-team-kit/skills/review/SKILL.md";
      const skill = "---\nname: review\ndescription: >\n  Review code.\n---\n\n# Review\n";
      const client = (body: string, contentType: string) =>
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, { headers: { "content-type": contentType } }),
            ),
          ),
        );
      const resolved = yield* resolveSkitSourceEffect(url).pipe(
        Effect.provideService(HttpClient.HttpClient, client(skill, "text/plain")),
      );
      expect(yield* readText(join(resolved.root, "skills", "review", "SKILL.md"))).toBe(skill);

      const failure = yield* resolveSkitSourceEffect(url).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          client("<!doctype html><title>GitHub</title>", "text/html"),
        ),
        Effect.flip,
      );
      expect(failure).toMatchObject({
        _tag: "DirectSkillDocumentInvalid",
        code: "VALIDATION_FAILED",
      });
    }).pipe(provide),
  );

  it.effect("rejects links in extracted archives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-archive-link-");
      yield* writeText(join(root, "SKILL.md"), "# Skill\n");
      yield* fs.symlink("SKILL.md", join(root, "linked.md"));
      const failure = yield* Effect.flip(auditExtractedSourceEffect(root));
      assert.match(failure.message, /unsupported entry/);
    }).pipe(provide),
  );

  it.effect("cleans its temporary workspace after archive rejection", () =>
    Effect.gen(function* () {
      // Private temporary root so a concurrently running suite's workspaces cannot be mistaken
      // for a leak from this call.
      const fs = yield* FileSystem.FileSystem;
      const previous = process.env.TMPDIR;
      const isolated = yield* scratch("skit-source-scan-");
      process.env.TMPDIR = isolated;
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const client = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(Uint8Array.from([1, 2, 3]), {
                  headers: { "content-type": "application/zip" },
                }),
              ),
            ),
          );
          yield* Effect.scoped(
            resolveSkitSourceEffect("https://example.test/source.zip").pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            ),
          ).pipe(Effect.flip);
          expect(
            (yield* fs.readDirectory(isolated)).filter((name) => name.startsWith("skit-source-")),
          ).toEqual([]);
        }),
        Effect.sync(() => {
          if (previous === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = previous;
        }),
      );
    }).pipe(provide),
  );

  it.effect("rejects archives exceeding the file-count limit", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-archive-count-");
      yield* Effect.forEach(
        Array.from({ length: 1001 }, (_, index) => join(root, `file-${index}`)),
        (path) => writeText(path, ""),
        { concurrency: 16, discard: true },
      );
      const failure = yield* Effect.flip(auditExtractedSourceEffect(root));
      assert.match(failure.message, /too many files/);
    }).pipe(provide),
  );

  it.effect("rejects archives exceeding the extracted-byte limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-archive-size-");
      const path = join(root, "large.bin");
      yield* writeText(path, "");
      yield* fs.truncate(path, 25 * 1024 * 1024 + 1);
      const failure = yield* Effect.flip(auditExtractedSourceEffect(root));
      assert.match(failure.message, /extracted size limit/);
    }).pipe(provide),
  );

  it.effect("keeps SSH and enterprise Git remotes as plain remotes without fragments", () =>
    Effect.gen(function* () {
      expect(yield* parseSkitSourceEffect("git@github.com:private/tools.git")).toEqual({
        type: "git",
        remote: "git@github.com:private/tools.git",
      });
      expect(yield* parseSkitSourceEffect("https://git.corp.example/agents/tools.git")).toEqual({
        type: "git",
        remote: "https://git.corp.example/agents/tools.git",
      });
      for (const input of [
        "git@github.com:private/tools.git#ref=main&path=skills/review",
        "https://git.corp.example/agents/tools.git#ref=v1",
      ])
        expect((yield* parseSkitSourceEffect(input).pipe(Effect.flip))._tag).toBe(
          "GitSourceFragment",
        );
    }).pipe(provide),
  );

  it.effect("rejects traversal, absolute, and Windows-absolute archive entries", () =>
    Effect.gen(function* () {
      for (const path of ["../escape", "nested/../../escape", "/absolute", "C:\\absolute"])
        expect(yield* Effect.flip(assertArchivePaths([path]))).toMatchObject({
          _tag: "UnsafeArchivePath",
          path,
        });
      yield* assertArchivePaths(["safe/nested/SKILL.md"]);
    }),
  );

  it.effect("pins a local Git checkout to its exact commit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-local-git-");
      yield* fs.makeDirectory(join(root, "skill"));
      yield* writeText(
        join(root, "skill", "SKILL.md"),
        "---\nname: review\ndescription: Review.\n---\n",
      );
      yield* git(root, "init", "-q");
      yield* git(root, "add", ".");
      yield* git(
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture",
      );
      const expected = yield* git(root, "rev-parse", "HEAD");
      const resolved = yield* resolve(root);
      expect(resolved.revision).toEqual({ kind: "commit", commit: expected });
    }).pipe(provide),
  );

  it.effect("rejects a malformed skit.json instead of generating a Descriptor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-malformed-config-");
      yield* fs.makeDirectory(join(root, "skill"));
      yield* writeText(join(root, "skit.json"), '{"slug": 1}\n');
      yield* writeText(
        join(root, "skill", "SKILL.md"),
        "---\nname: review\ndescription: Review.\n---\n",
      );

      const exit = yield* Effect.exit(resolve(root));
      expect(exit._tag).toBe("Failure");
    }).pipe(provide),
  );
});
