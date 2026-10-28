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
  auditExtractedSource,
  parseSkitSource,
  sourceLocator,
  sourceLocatorProfiles,
  sourceInputWithVersion,
  resolveSkitSource,
} from "../src/sources/resolve.js";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { skitLayer, type SkitServices } from "../src/platform/layer.js";
import { prepareImport } from "../src/library/import-collection.js";

const git = (cwd: string, ...args: string[]) =>
  Effect.sync(() => execFileSync("git", args, { cwd, encoding: "utf8" }).trim());
const scratch = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));
const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));
const writeText = (path: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));
/** A Source of plain Agent Skills whose workspace the surrounding test Scope releases. */
const resolve = (...args: Parameters<typeof resolveSkitSource>) =>
  resolveSkitSource(...args).pipe(
    Effect.map((resolved) => {
      assert(resolved.descriptorKind === "observed");
      return resolved;
    }),
  );
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
  it.effect(
    "retains selected Git directory links as Skill content through subpaths and member selections",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitLinkFixture;
        const selections = [
          { source: { subpath: fixture.selectedPath }, path: "." },
          {
            source: { subpath: fixture.selectedPath, skillDirectories: ["."] },
            path: ".",
          },
          { source: { subpath: "plugins/linked/skills/review" }, path: "." },
          {
            source: { skillDirectories: ["plugins/linked/skills/review"] },
            path: "plugins/linked/skills/review",
          },
          { source: { subpath: "contained-chain" }, path: "." },
          {
            source: { skillDirectories: [fixture.selectedPath] },
            path: fixture.selectedPath,
          },
        ];
        for (const selected of selections) {
          const source = { type: "git" as const, remote: fixture.remote, ...selected.source };
          const observed = yield* resolve(source);
          expect(observed.foundSkillPaths).toEqual([selected.path]);
          const sourcePath = join(observed.originalRoot, selected.path);
          const prepared = yield* prepareImport([
            {
              name: "review",
              sourcePath,
              relativePath: selected.path,
              currentHash: yield* deterministicTreeHash(sourcePath),
            },
          ]);
          expect(yield* readText(join(prepared.staged, selected.path, "SKILL.md"))).toEqual(
            fixture.content,
          );
          expect(
            yield* readText(join(prepared.staged, selected.path, "references/guide.md")),
          ).toEqual("Supporting reference.\n");
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
          { source: { subpath: path } },
          { source: { skillDirectories: [path] } },
        ]) {
          const error = yield* resolve({
            type: "git",
            remote: fixture.remote,
            ...selection.source,
          }).pipe(Effect.flip);
          assert.strictEqual(error._tag, "SourcePolicyViolation");
          assert.include(error.message, "outside the checkout");
        }
      }
    }).pipe(provide),
  );
  it.effect("reports dangling Git selections clearly", () =>
    Effect.gen(function* () {
      const fixture = yield* gitLinkFixture;
      const source = { type: "git" as const, remote: fixture.remote };
      const subpathError = yield* resolve({ ...source, subpath: "dangling" }).pipe(Effect.flip);
      assert.strictEqual(subpathError._tag, "SourcePolicyViolation");
      assert.include(subpathError.message, "symlink target is unavailable: dangling");
      const memberError = yield* resolve({ ...source, skillDirectories: ["dangling"] }).pipe(
        Effect.flip,
      );
      assert.strictEqual(memberError._tag, "SourcePolicyViolation");
      assert.include(memberError.message, "Locked Skill path is missing");
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
      const resolved = yield* resolve({
        type: "git",
        remote: fixture.remote,
        subpath: fixture.selectedPath,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempDirectoryScoped: (options) =>
            fs.makeTempDirectoryScoped({ ...options, directory: alias }),
        }),
      );
      expect(resolved.foundSkillPaths).toEqual(["."]);
      expect(yield* readText(join(resolved.originalRoot, "SKILL.md"))).toEqual(fixture.content);
    }).pipe(provide),
  );
  it.effect("does not infer plugin ownership from a directory name in a selected Git subpath", () =>
    Effect.gen(function* () {
      const fixture = yield* gitLinkFixture;
      const selected = yield* resolve({ type: "git", remote: fixture.remote, subpath: "example" });
      expect(selected.foundSkillPaths?.toSorted()).toEqual([
        "plugins/bundle/skills/review",
        "skills/review",
      ]);
    }).pipe(provide),
  );
  it.effect("discovers ordinary directories named plugins without manifest declarations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-plugin-discovery-");
      for (const path of [
        "skills/review",
        "plugins/bundle/skills/review",
        ".github/plugins/bundle/skills/review",
        "examples/plugins/demo",
      ]) {
        yield* fs.makeDirectory(join(root, path), { recursive: true });
        yield* writeText(
          join(root, path, "SKILL.md"),
          "---\nname: review\ndescription: Review.\n---\n",
        );
      }
      const discovered = yield* resolve(root);
      expect(discovered.foundSkillPaths?.toSorted()).toEqual([
        ".github/plugins/bundle/skills/review",
        "examples/plugins/demo",
        "plugins/bundle/skills/review",
        "skills/review",
      ]);
    }).pipe(provide),
  );
  it.effect("allows an explicitly selected plugin Skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-explicit-plugin-");
      const path = "plugins/bundle/skills/review";
      yield* fs.makeDirectory(join(root, path), { recursive: true });
      yield* writeText(
        join(root, path, "SKILL.md"),
        "---\nname: review\ndescription: Review.\n---\n",
      );
      const direct = yield* resolve(join(root, path));
      expect(direct.foundSkillPaths).toEqual(["."]);
      yield* fs.symlink(join(root, path), join(root, "selected-link"));
      const linked = yield* resolve(join(root, "selected-link"));
      expect(linked.originalRoot).toEqual(yield* fs.realPath(join(root, path)));
      expect(linked.foundSkillPaths).toEqual(["."]);
    }).pipe(provide),
  );
  it.effect("imports plugin-only Sources with their original member paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-plugin-only-");
      yield* fs.makeDirectory(join(root, "plugins/bundle/skills/review"), { recursive: true });
      yield* writeText(
        join(root, "plugins/bundle/skills/review/SKILL.md"),
        "---\nname: review\ndescription: Review.\n---\n",
      );
      const source = yield* resolve(root);
      expect(source.foundSkillPaths).toEqual(["plugins/bundle/skills/review"]);
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
        const discovered = yield* resolve(root);
        expect(discovered.foundSkillPaths?.toSorted()).toEqual([
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
  it.effect("resolves shorthand deterministically before acquisition", () =>
    Effect.gen(function* () {
      expect(yield* parseSkitSource("tim/dad-joke@1.0.0")).toEqual({
        type: "registry",
        namespace: "tim",
        slug: "dad-joke",
        version: "1.0.0",
      });
      expect(yield* parseSkitSource("humanlayer/skills")).toEqual({
        type: "github",
        owner: "humanlayer",
        repository: "skills",
      });
      expect(yield* sourceInputWithVersion("humanlayer/skills", "1.2.0")).toBe(
        "skit:humanlayer/skills",
      );
      expect(yield* parseSkitSource("gh:humanlayer/skills")).toEqual({
        type: "github",
        owner: "humanlayer",
        repository: "skills",
      });
      expect(yield* parseSkitSource("skit:humanlayer/skills")).toEqual({
        type: "registry",
        namespace: "humanlayer",
        slug: "skills",
      });
      const canonical = yield* parseSkitSource("skit://registry.example/humanlayer/skills@1.2.0");
      expect(canonical).toEqual({
        type: "registry",
        namespace: "humanlayer",
        slug: "skills",
        version: "1.2.0",
        authority: "https://registry.example",
      });
      expect(sourceLocator(canonical)).toBe("skit://registry.example/humanlayer/skills@1.2.0");
      const loopback = yield* parseSkitSource("skit+http://127.0.0.1:8787/humanlayer/skills@1.2.0");
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
      expect(yield* sourceInputWithVersion("humanlayer/skills", "1.2.0", root)).toBe(
        "humanlayer/skills",
      );
      expect(yield* parseSkitSource("humanlayer/skills", root)).toEqual({
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
        expect(yield* parseSkitSource(input)).toEqual({
          type: "github",
          owner: "mattpocock",
          repository: "skills",
        });
      for (const input of [
        "https://github.com/mattpocock/skills/tree/main/skills/code-review",
        "https://github.com/mattpocock/skills/tree/main/skills/code-review/",
      ])
        expect(yield* parseSkitSource(input)).toEqual({
          type: "github",
          owner: "mattpocock",
          repository: "skills",
          ref: "main",
          subpath: "skills/code-review",
        });
      expect(yield* parseSkitSource("https://github.com/mattpocock/skills/tree/v1.2.0")).toEqual({
        type: "github",
        owner: "mattpocock",
        repository: "skills",
        ref: "v1.2.0",
      });
      expect(
        (yield* parseSkitSource(
          "https://github.com/mattpocock/skills/tree/main/skills/../../escape",
        ).pipe(Effect.flip))._tag,
      ).toBe("UnsafeGitSubpath");
      for (const input of [
        "https://github.com/mattpocock/skills#ref=main",
        "https://github.com/mattpocock/skills.git#skill=review%2FSKILL.md",
        "https://github.com/mattpocock/skills/tree/main/skills#top",
      ])
        expect((yield* parseSkitSource(input).pipe(Effect.flip))._tag).toBe("GitSourceFragment");
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
        expect(yield* parseSkitSource(sourceLocator(source))).toEqual(source);
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

  it.effect("reacquires only locked Git Skill paths", () =>
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
      const first = yield* resolve(source);
      expect(first.foundSkillPaths).toEqual(["skills/review"]);
      const firstHash = yield* deterministicTreeHash(first.originalRoot);
      expect(yield* readText(join(first.originalRoot, "skills", "review", "SKILL.md"))).toContain(
        "# review",
      );
      expect(yield* fs.exists(join(first.originalRoot, "skills", "other"))).toBe(false);
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
      const second = yield* resolve(source);
      expect(yield* deterministicTreeHash(second.originalRoot)).toBe(firstHash);
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
      expect(yield* parseSkitSource(`wellknown:${base}`)).toEqual({
        type: "well-known",
        origin: base,
      });
      expect(yield* parseSkitSource(base)).toEqual({
        type: "well-known",
        origin: base,
      });
      expect(yield* parseSkitSource(`${base}/`)).toEqual({
        type: "well-known",
        origin: base,
      });
      const resolved = yield* resolve(base).pipe(
        Effect.provideService(HttpClient.HttpClient, client(skill)),
      );
      expect(resolved.source.type).toBe("well-known");
      expect(sourceLocator(resolved.source)).toBe(`wellknown:${base}`);
      expect(resolved.foundSkillPaths).toEqual(["review"]);
      expect(yield* readText(join(resolved.originalRoot, "review", "SKILL.md"))).toBe(skill);
      const failure = yield* resolve(`wellknown:${base}`).pipe(
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
      expect(yield* parseSkitSource("https://skills.example/SKILL.md")).toEqual({
        type: "url",
        url: "https://skills.example/SKILL.md",
      });
      expect(yield* parseSkitSource("https://skills.example/catalog")).toEqual({
        type: "url",
        url: "https://skills.example/catalog",
      });
      for (const input of [
        "https://skills.example#skills=review",
        "https://skills.example?collection=review",
        "https://skills.example/#",
        "https://skills.example/?",
      ]) {
        const failure = yield* parseSkitSource(input).pipe(Effect.flip);
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
      const first = yield* resolve(`wellknown:${base}`).pipe(
        Effect.provideService(HttpClient.HttpClient, client("first")),
      );
      const second = yield* resolve(first.source).pipe(
        Effect.provideService(HttpClient.HttpClient, client("second")),
      );
      expect(yield* readText(join(first.originalRoot, "review", "references", "guide.md"))).toBe(
        "first",
      );
      expect(yield* readText(join(second.originalRoot, "review", "references", "guide.md"))).toBe(
        "second",
      );
      expect(yield* deterministicTreeHash(first.originalRoot)).not.toBe(
        yield* deterministicTreeHash(second.originalRoot),
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
      const rejected = yield* parseSkitSource(`wellknown:${base}#skills=review`).pipe(Effect.flip);
      expect(rejected._tag).toBe("UnsafeSourceUrl");
      const parsed = { type: "well-known" as const, origin: base, skillNames: ["review"] };
      expect(sourceLocator(parsed)).toBe(`wellknown:${base}`);
      const resolved = yield* resolve(parsed).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(yield* readText(join(resolved.originalRoot, "review", "references", "guide.md"))).toBe(
        "Guide",
      );
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
      const failure = yield* resolve(`wellknown:${base}`).pipe(
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
      const failure = yield* resolve("wellknown:https://reset.example").pipe(
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
        yield* parseSkitSource(
          "https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/review/SKILL.md#L1",
        ),
      ).toEqual({
        type: "url",
        url: "https://raw.githubusercontent.com/cursor/plugins/main/cursor-team-kit/skills/review/SKILL.md#L1",
      });
      expect(
        yield* parseSkitSource(
          "https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/review/SKILL.md",
        ),
      ).toEqual({
        type: "url",
        url: "https://raw.githubusercontent.com/cursor/plugins/main/cursor-team-kit/skills/review/SKILL.md",
      });
      expect(
        yield* parseSkitSource(
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
      const resolved = yield* resolve(url).pipe(
        Effect.provideService(HttpClient.HttpClient, client(skill, "text/plain")),
      );
      expect(resolved.foundSkillPaths).toEqual(["."]);
      expect(yield* readText(join(resolved.originalRoot, "SKILL.md"))).toBe(skill);

      const failure = yield* resolve(url).pipe(
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
      const failure = yield* Effect.flip(auditExtractedSource(root));
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
            resolveSkitSource("https://example.test/source.zip").pipe(
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
      const failure = yield* Effect.flip(auditExtractedSource(root));
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
      const failure = yield* Effect.flip(auditExtractedSource(root));
      assert.match(failure.message, /extracted size limit/);
    }).pipe(provide),
  );

  it.effect("keeps SSH and enterprise Git remotes as plain remotes without fragments", () =>
    Effect.gen(function* () {
      expect(yield* parseSkitSource("git@github.com:private/tools.git")).toEqual({
        type: "git",
        remote: "git@github.com:private/tools.git",
      });
      expect(yield* parseSkitSource("https://git.corp.example/agents/tools.git")).toEqual({
        type: "git",
        remote: "https://git.corp.example/agents/tools.git",
      });
      for (const input of [
        "git@github.com:private/tools.git#ref=main&path=skills/review",
        "https://git.corp.example/agents/tools.git#ref=v1",
      ])
        expect((yield* parseSkitSource(input).pipe(Effect.flip))._tag).toBe("GitSourceFragment");
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
