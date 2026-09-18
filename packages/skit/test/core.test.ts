import { Deferred, Effect, Fiber, FileSystem, Layer, Result, Stream } from "effect";
import { it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import { skitLayer, sourceProcessLayer, validateSkitDirectoryEffect } from "../src/index.js";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  deterministicTreeHashEffect,
  hashProjectedSkillFiles,
  LinkStat,
  parseSkitConfig,
  parseSkitReadme,
  inspectNormalizedTreeEffect,
  walkTreeEffect,
} from "../src/index.js";
import { copySkitFixtureEffect } from "./helpers/skit-fixture.js";

const validSkitEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-core-" });
  yield* copySkitFixtureEffect("authored", root);
  return root;
});

/** Git is exercised through its CLI; the call is synchronous and stays out of the platform seam. */
const git = (...args: string[]) => Effect.sync(() => void execFileSync("git", args));
const author = (root: string) =>
  validateSkitDirectoryEffect(root, "draft", { assessmentContext: "author" });
const authorFailure = (root: string) => Effect.flip(author(root));

test("pins depth-first code-unit ordering for Skill Artifact digests", () => {
  const files = [
    ["a.md", "A"],
    ["a/b.md", "B"],
    ["z.md", "Z"],
    ["ä.md", "U"],
  ].map(([path, contents]) => ({
    path: `skills/review/${path}`,
    bytes: new TextEncoder().encode(contents),
  }));

  expect(hashProjectedSkillFiles(files, "skills/review")).toBe(
    "sha256:8e60154df4bbfb3eb6cc8ae833518f4c6ef1c82df527ba6b00260fdfec995ad1",
  );
});

it.effect("validates independent valid and invalid descriptors", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const valid = yield* validSkitEffect;
    expect((yield* author(valid)).diagnostics).not.toContainEqual(
      expect.objectContaining({ severity: "error" }),
    );
    const invalid = yield* fs.makeTempDirectoryScoped({ prefix: "skit-core-invalid-" });
    yield* copySkitFixtureEffect("sentinel-id", invalid);
    expect((yield* Effect.exit(author(invalid)))._tag).toBe("Failure");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

test("normalizes legacy Forge declarations without retaining unenforceable claims", () => {
  const descriptor = parseSkitConfig(
    JSON.stringify({
      slug: "tools",
      skills: [
        {
          name: "review",
          path: "skills/review",
          trigger_modes: ["explicit"],
          mutation_scopes: ["repository"],
          capabilities: ["filesystem_read"],
          approval: "always",
          expected_outputs: ["review"],
        },
      ],
    }),
  );

  expect(descriptor.skills).toEqual([
    {
      name: "review",
      path: "skills/review",
      default_enabled: true,
      invocation: "explicit",
      capabilities: ["filesystem_read"],
    },
  ]);
});

test.each(["internal/normalized", "local/internal-normalized"])(
  "reads retained Agent Skills wrappers with legacy sentinel %s",
  (id) => {
    const descriptor = parseSkitReadme(
      `---\nskit: 1\nid: ${id}\nskills:\n  - name: review\n    path: skills/review\n    default_enabled: true\n---\n`,
    );

    expect(descriptor.slug).toBe("internal-normalized");
    expect(descriptor).not.toHaveProperty("id");
  },
);

test("does not accept arbitrary legacy Descriptor IDs", () => {
  expect(() =>
    parseSkitReadme(
      "---\nskit: 1\nid: somebody/tools\nskills:\n  - name: review\n    path: skills/review\n    default_enabled: true\n---\n",
    ),
  ).toThrow();
});

test("rejects conflicting legacy and current invocation declarations", () => {
  expect(() =>
    parseSkitConfig(
      JSON.stringify({
        slug: "tools",
        skills: [
          {
            name: "review",
            path: "skills/review",
            invocation: "explicit",
            trigger_modes: ["implicit"],
          },
        ],
      }),
    ),
  ).toThrow(/conflicting invocation and trigger_modes/);
});

test("omits an empty capability claim from the canonical descriptor", () => {
  expect(
    parseSkitConfig(
      JSON.stringify({
        slug: "tools",
        skills: [{ name: "review", path: "skills/review", capabilities: [] }],
      }),
    ).skills[0],
  ).not.toHaveProperty("capabilities");
});

it.effect("preserves structured Skill assessment separately from validation diagnostics", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* fs.writeFileString(
      join(root, "skills", "review", "SKILL.md"),
      '---\nname: review\ndescription: Review.\n---\n\nCall spawn("sh").\n',
    );

    const validation = yield* author(root);

    expect(validation.audits["tools:review"].findings).toContainEqual(
      expect.objectContaining({
        ruleId: "process.api-execution",
        confidence: "high",
        location: expect.objectContaining({
          path: "skills/review/SKILL.md",
          line: 6,
          column: 6,
        }),
      }),
    );
    expect(validation.assessments["tools:review"]).toEqual(
      expect.objectContaining({
        context: "author",
        outcome: "warn",
        reasons: [expect.objectContaining({ code: "AUTHOR_REVIEW_RECOMMENDED" })],
      }),
    );
    expect(validation.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SECURITY_ASSESSMENT_WARNING", severity: "warning" }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("tree hashes independently reflect bytes and executable mode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-hash-" });
    const file = join(root, "tool");
    yield* fs.writeFile(file, Uint8Array.from([0, 1, 255]));
    const original = yield* deterministicTreeHashEffect(root);
    yield* fs.writeFile(file, Uint8Array.from([0, 1, 254]));
    expect(yield* deterministicTreeHashEffect(root)).not.toBe(original);
    yield* fs.writeFile(file, Uint8Array.from([0, 1, 255]));
    yield* fs.chmod(file, 0o755);
    expect(yield* deterministicTreeHashEffect(root)).not.toBe(original);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("verbatim walking preserves filename normalization", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-verbatim-unicode-" });
    const decomposed = `cafe\u0301.md`;
    yield* fs.writeFileString(join(root, decomposed), "same\n");
    expect((yield* walkTreeEffect(root, "verbatim"))[0]?.path).toBe(decomposed);
    expect((yield* walkTreeEffect(root, "normalized"))[0]?.path).toBe(decomposed.normalize("NFC"));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("normalized SKIT content excludes repository author-home metadata", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* fs.makeDirectory(join(root, "fixtures"));
    yield* fs.writeFileString(
      join(root, "skit.remote.json"),
      '{"schema":"skit.remote.v1","origin":"https://registry.test","namespace":"tim","skit":"tools"}\n',
    );
    yield* fs.writeFileString(join(root, "fixtures", "skit.remote.json"), '{"fixture":true}\n');
    yield* fs.makeDirectory(join(root, ".skit"));
    yield* fs.writeFileString(join(root, ".skit", "workspace.json"), '{"device":"local"}\n');
    yield* fs.makeDirectory(join(root, "fixtures", ".skit"));
    yield* fs.writeFileString(join(root, "fixtures", ".skit", "nested.txt"), "artifact content\n");
    const normalizedPaths = (yield* walkTreeEffect(root, "normalized")).map((entry) => entry.path);
    expect(normalizedPaths).not.toContain("skit.remote.json");
    expect(normalizedPaths).not.toContain(".skit/workspace.json");
    expect(normalizedPaths).toContain("fixtures/skit.remote.json");
    expect(normalizedPaths).toContain("fixtures/.skit/nested.txt");
    expect((yield* walkTreeEffect(root, "verbatim")).map((entry) => entry.path)).toContain(
      "skit.remote.json",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content follows Git's effective ignore decision", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* git("init", "--quiet", root);
    const globalExcludes = join(root, ".git", "global-excludes");
    yield* fs.writeFileString(
      globalExcludes,
      ".claude/settings.local.json\n.codex/hooks.json\nglobal-only.txt\n",
    );
    yield* git("-C", root, "config", "core.excludesFile", globalExcludes);
    yield* fs.writeFileString(join(root, ".gitignore"), "*.log\n");
    yield* fs.writeFileString(join(root, ".git", "info", "exclude"), "info-only.txt\n");
    yield* fs.makeDirectory(join(root, ".claude"));
    yield* fs.makeDirectory(join(root, ".codex"));
    yield* fs.makeDirectory(join(root, "nested"));
    yield* fs.writeFileString(join(root, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n");
    yield* fs.writeFileString(join(root, ".claude", "settings.local.json"), "local\n");
    yield* fs.writeFileString(join(root, ".codex", "hooks.json"), "local\n");
    yield* fs.writeFileString(
      join(root, "skills", "review", "ignored.log"),
      "ignored skill content\n",
    );
    yield* fs.writeFileString(join(root, "ignored.log"), "ignored\n");
    yield* fs.writeFileString(join(root, "tracked.log"), "tracked\n");
    yield* fs.writeFileString(join(root, "info-only.txt"), "ignored\n");
    yield* fs.writeFileString(join(root, "global-only.txt"), "ignored\n");
    yield* fs.writeFileString(join(root, "nested", "drop.tmp"), "ignored\n");
    yield* fs.writeFileString(join(root, "nested", "keep.tmp"), "included\n");
    yield* fs.writeFileString(join(root, "untracked.md"), "included\n");
    yield* git("-C", root, "add", "-f", "tracked.log");

    const validation = yield* author(root);
    const paths = validation.files.map((file) => file.path);

    expect(paths).toContain("tracked.log");
    expect(paths).toContain("untracked.md");
    expect(paths).toContain("nested/keep.tmp");
    expect(paths).not.toContain("ignored.log");
    expect(paths).not.toContain("nested/drop.tmp");
    expect(paths).not.toContain("info-only.txt");
    expect(paths).not.toContain("global-only.txt");
    expect(paths).not.toContain(".claude/settings.local.json");
    expect(paths).not.toContain(".codex/hooks.json");
    const withoutIgnoredSkillFile = validation.identity.skills[0].contentHash;
    yield* fs.writeFileString(
      join(root, "skills", "review", "ignored.log"),
      "changed ignored content\n",
    );
    expect((yield* author(root)).identity.skills[0].contentHash).toBe(withoutIgnoredSkillFile);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content remains available outside a Git worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* fs.writeFileString(join(root, ".gitignore"), "local.txt\n");
    yield* fs.writeFileString(join(root, "local.txt"), "included without Git\n");

    const validation = yield* author(root);

    expect(validation.files.map((file) => file.path)).toContain("local.txt");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("normalized tree inspection reports ignored and control exclusions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* git("init", "--quiet", root);
    yield* fs.writeFileString(join(root, ".gitignore"), "ignored/\n");
    yield* fs.makeDirectory(join(root, "ignored", "nested"), { recursive: true });
    yield* fs.writeFileString(join(root, "ignored", "secret.txt"), "secret\n");
    yield* fs.writeFileString(join(root, "ignored", "nested", "asset.txt"), "asset\n");
    yield* fs.writeFileString(join(root, ".DS_Store"), "control\n");

    const inspection = yield* inspectNormalizedTreeEffect(root, { respectGitIgnore: true });

    expect(inspection.entries.map((entry) => entry.path)).not.toEqual(
      expect.arrayContaining(["ignored/secret.txt", ".DS_Store"]),
    );
    expect(inspection.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".DS_Store",
          kind: "file",
          reason: "normalized-control-exclusion",
        }),
        expect.objectContaining({
          path: "ignored",
          kind: "directory",
          bytes: 0,
          opaque: true,
          reason: "gitignored",
        }),
      ]),
    );
    const links = yield* LinkStat;
    yield* walkTreeEffect(root, "normalized", { respectGitIgnore: true }).pipe(
      Effect.provideService(LinkStat, {
        ...links,
        lstat: (path) =>
          [".DS_Store", "ignored"].some((name) => String(path).endsWith(name))
            ? Effect.die(`unexpected excluded-entry lstat: ${path}`)
            : links.lstat(path),
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content fails closed when a detected Git worktree cannot be queried", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* fs.makeDirectory(join(root, ".git"));

    const result = yield* walkTreeEffect(root, "normalized", {
      respectGitIgnore: true,
    }).pipe(Effect.result);
    expect(result).toMatchObject({ failure: { _tag: "TreeError" } });
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ reason: { _tag: "GitInspectionFailed" } });
      expect(result.failure.message).toContain(
        "Unable to evaluate Git ignore rules for Artifact content",
      );
    }
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content rejects a SKIT root ignored by an enclosing worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outer = yield* fs.makeTempDirectoryScoped({ prefix: "skit-ignored-root-" });
    const root = join(outer, "mykit");
    yield* git("init", "--quiet", outer);
    yield* fs.writeFileString(join(outer, ".gitignore"), "mykit/\n");
    yield* copySkitFixtureEffect("authored", root);
    yield* git("-C", outer, "add", "-f", "mykit/README.md");

    const failure = yield* authorFailure(root);
    expect(failure).toMatchObject({ reason: { _tag: "IgnoredRoot" } });
    expect(failure.message).toContain("The SKIT root is ignored by the enclosing Git repository");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content rejects embedded Git repositories explicitly", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* git("init", "--quiet", root);
    const embedded = join(root, "vendored");
    yield* git("init", "--quiet", embedded);
    yield* fs.writeFileString(join(embedded, "library.md"), "nested repository content\n");

    const failure = yield* authorFailure(root);
    expect(failure).toMatchObject({
      reason: { _tag: "EmbeddedRepository", path: "vendored" },
    });
    expect(failure.message).toContain(
      "Embedded Git repository is not valid Artifact content: vendored",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content rejects registered Git submodules explicitly", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.makeTempDirectoryScoped({ prefix: "skit-submodule-source-" });
    yield* git("init", "--quiet", source);
    yield* fs.writeFileString(join(source, "library.md"), "submodule content\n");
    yield* git("-C", source, "add", "library.md");
    yield* git(
      "-C",
      source,
      "-c",
      "user.name=SKIT Test",
      "-c",
      "user.email=skit@example.test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const root = yield* validSkitEffect;
    yield* git("init", "--quiet", root);
    yield* git(
      "-C",
      root,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      source,
      "vendored",
    );

    const failure = yield* authorFailure(root);
    expect(failure).toMatchObject({ reason: { _tag: "Submodule", path: "vendored" } });
    expect(failure.message).toContain(
      "Registered Git submodule is not valid Artifact content: vendored",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content rejects a worktree whose files are all ignored", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* git("init", "--quiet", root);
    yield* fs.writeFileString(join(root, ".gitignore"), "*\n");

    const failure = yield* authorFailure(root);
    expect(failure).toMatchObject({ reason: { _tag: "FullyExcludedRoot" } });
    expect(failure.message).toContain("Git excludes every file in the SKIT root");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author content stays scoped to a SKIT nested in an enclosing worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outer = yield* fs.makeTempDirectoryScoped({ prefix: "skit-nested-root-" });
    const root = join(outer, "packages", "mykit");
    yield* git("init", "--quiet", outer);
    yield* fs.makeDirectory(join(outer, "packages"));
    yield* fs.writeFileString(join(outer, ".gitignore"), ".env\n");
    yield* fs.writeFileString(join(outer, "sibling.md"), "outside\n");
    yield* fs.writeFileString(join(outer, ".env"), "outside and ignored\n");
    yield* copySkitFixtureEffect("authored", root);

    const validation = yield* author(root);

    expect(validation.files.map((file) => file.path)).toEqual([
      "README.md",
      "skills/review/SKILL.md",
      "skills/review/agents/openai.yaml",
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each([
  ["skit.json", "{", { _tag: "DescriptorMalformed", format: "json" }],
  ["README.md", "---\nskit: [\n---\n", { _tag: "DescriptorMalformed", format: "yaml" }],
  ["skit.json", "{}", { _tag: "DescriptorMalformed", format: "json" }],
  ["README.md", "---\nskit: *missing\n---\n", { _tag: "DescriptorMalformed", format: "yaml" }],
  ["README.md", "missing frontmatter", { _tag: "ReadmeFrontmatterMissing" }],
] as const)("declares %s %s as a named Descriptor failure", ([file, body, expected]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-parser-" });
    yield* fs.writeFileString(join(root, file), body);
    const failure = yield* Effect.flip(
      validateSkitDirectoryEffect(root, "draft", { assessmentContext: "author" }),
    );
    expect(failure).toMatchObject(expected);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["author", "publish"] as const)(
  "%s validation drains stderr and finalizes Git on interruption",
  (assessmentContext) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* validSkitEffect;
      yield* fs.makeDirectory(join(root, ".git"));
      const ready = yield* Deferred.make<void>();
      let finalized = false;
      const operation = Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const interruptedSpawner = {
          ...spawner,
          spawn: (command: Parameters<typeof spawner.spawn>[0]) =>
            Effect.gen(function* () {
              // Registered first, so this runs after the real handle's release.
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized = true;
                }),
              );
              const handle = yield* spawner.spawn(command);
              return {
                ...handle,
                stdout: Stream.fromEffect(Effect.never),
                stderr: Stream.fromEffect(
                  Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
                ),
              };
            }),
        };
        return yield* validateSkitDirectoryEffect(root, "draft", { assessmentContext }).pipe(
          Effect.provide(
            Layer.fresh(
              sourceProcessLayer.pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, interruptedSpawner),
                ),
              ),
            ),
          ),
        );
      });
      const fiber = yield* Effect.forkChild(operation);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(finalized).toBe(true);
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("malformed invocation metadata is a named validation failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* fs.writeFileString(
      join(root, "skit.json"),
      JSON.stringify({
        slug: "tools",
        skills: [{ name: "review", path: "skills/review", invocation: "explicit" }],
      }),
    );
    yield* fs.writeFileString(join(root, "skills/review/SKILL.md"), "---\nname: [\n---\n");
    expect(
      yield* Effect.flip(
        validateSkitDirectoryEffect(root, "draft", { assessmentContext: "author" }),
      ),
    ).toMatchObject({ _tag: "HarnessMetadataInvalid" });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("projected content collisions enter the validation error channel", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* validSkitEffect;
    yield* fs.writeFileString(
      join(root, "skit.json"),
      JSON.stringify({
        slug: "tools",
        skills: [
          {
            name: "review",
            path: "skills/review",
            shared: [{ from: "README.md", to: "SKILL.md" }],
          },
        ],
      }),
    );
    expect(
      yield* Effect.flip(
        validateSkitDirectoryEffect(root, "draft", { assessmentContext: "author" }),
      ),
    ).toMatchObject({ _tag: "SharedTargetCollision" });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
