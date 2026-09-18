import { Result } from "effect";
import { Cause, Deferred, Effect, Fiber, FileSystem } from "effect";
import { it as effectIt } from "@effect/vitest";
import { skitLayer } from "../src/platform/layer.js";
import { invocationMetadataAdapters } from "../src/harnesses/invocation-metadata.js";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  applyInvocationPolicyEffect,
  assessInvocationConformance,
  createSkitArchiveEffect,
  generateInvocationMetadataEffect,
  isAuthorWorkspaceEffect,
  resolveDeclaredInvocation,
  validateSkitDirectoryEffect,
  type InvocationPolicy,
} from "../src/index.js";

const CODEX_PATH = "skills/review/agents/openai.yaml";
const CODEX = join("skills", "review", "agents", "openai.yaml");

function workspace(
  invocation: InvocationPolicy | undefined,
  frontmatter = "name: review\ndescription: Review.",
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-invocation-" });
    yield* fs.makeDirectory(join(root, ".skit"), { recursive: true });
    yield* fs.writeFileString(
      join(root, ".skit", "workspace.json"),
      `${JSON.stringify({
        schema: "skit.author-workspace.v1",
        workspace_id: `workspace_${"a".repeat(32)}`,
        registration: "registered",
      })}\n`,
    );
    yield* fs.makeDirectory(join(root, "skills", "review"), { recursive: true });
    yield* fs.writeFileString(join(root, "README.md"), "# Tools\n");
    yield* fs.writeFileString(
      join(root, "skit.json"),
      `${JSON.stringify({
        slug: "tools",
        skills: [
          {
            name: "review",
            path: "skills/review",
            default_enabled: true,
            ...(invocation ? { invocation } : {}),
          },
        ],
      })}\n`,
    );
    yield* fs.writeFileString(
      join(root, "skills", "review", "SKILL.md"),
      `---\n${frontmatter}\n---\n# Review\n`,
    );
    return root;
  });
}

const makeDirectory = (path: string, options?: { recursive?: boolean }) =>
  FileSystem.FileSystem.use((fs) => fs.makeDirectory(path, options));
const makeTemporaryDirectory = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "skit-invocation-archive-" }),
);
const read = (path: string) => FileSystem.FileSystem.use((fs) => fs.readFileString(path));
const remove = (path: string, options?: { recursive?: boolean; force?: boolean }) =>
  FileSystem.FileSystem.use((fs) => fs.remove(path, options));
const stat = (path: string) => FileSystem.FileSystem.use((fs) => fs.stat(path));
const write = (path: string, contents: string) =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(path, contents));
const exists = (path: string) => FileSystem.FileSystem.use((fs) => fs.exists(path));

effectIt.effect.each([
  ["explicit", "disable-model-invocation: true", "allow_implicit_invocation: false"],
  ["implicit", "disable-model-invocation: false", "allow_implicit_invocation: true"],
] as const)(
  "generation writes %s into both Harnesses' native metadata",
  ([policy, claude, codex]) =>
    Effect.gen(function* () {
      const root = yield* workspace(policy);

      const generated = yield* generateInvocationMetadataEffect(root);

      expect(generated.map((item) => [item.harness, item.changed])).toEqual([
        ["claude-code", true],
        ["codex", true],
      ]);
      expect(yield* read(join(root, "skills", "review", "SKILL.md"))).toContain(claude);
      expect(yield* read(join(root, CODEX))).toContain(codex);
      expect(
        (yield* validateSkitDirectoryEffect(root, "draft", { assessmentContext: "publish" }))
          .diagnostics,
      ).toEqual([]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect("generation removes both fields for host policy", () =>
  Effect.gen(function* () {
    const root = yield* workspace(
      "host-policy",
      "name: review\ndescription: Review.\ndisable-model-invocation: true",
    );
    yield* makeDirectory(join(root, "skills", "review", "agents"), { recursive: true });
    yield* write(join(root, CODEX), "policy:\n  allow_implicit_invocation: false\n");

    yield* generateInvocationMetadataEffect(root);

    expect(yield* read(join(root, "skills", "review", "SKILL.md"))).toBe(
      "---\nname: review\ndescription: Review.\n---\n# Review\n",
    );
    expect(yield* exists(join(root, CODEX))).toBe(false);
    expect(
      (yield* validateSkitDirectoryEffect(root, "draft", { assessmentContext: "publish" }))
        .diagnostics,
    ).toEqual([]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect(
  "an undeclared Skill keeps its native metadata through authoring and packaging",
  () =>
    Effect.gen(function* () {
      const root = yield* workspace(
        undefined,
        "name: review\ndescription: Review.\ndisable-model-invocation: false",
      );
      const before = yield* read(join(root, "skills", "review", "SKILL.md"));

      expect(yield* generateInvocationMetadataEffect(root)).toEqual([]);
      expect(
        (yield* validateSkitDirectoryEffect(root, "draft", { assessmentContext: "publish" }))
          .diagnostics,
      ).toEqual([]);
      const archive = join(yield* makeTemporaryDirectory, "release.zip");
      yield* createSkitArchiveEffect(root, archive);

      expect(yield* read(join(root, "skills", "review", "SKILL.md"))).toBe(before);
      expect(Number((yield* stat(archive)).size)).toBeGreaterThan(0);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect("generation refuses a source that is not an Author Workspace", () =>
  Effect.gen(function* () {
    const root = yield* workspace("explicit");
    yield* remove(join(root, ".skit"), { recursive: true });

    const result = yield* generateInvocationMetadataEffect(root).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NotAnAuthorWorkspace" },
    });
    expect(yield* read(join(root, "skills", "review", "SKILL.md"))).not.toContain(
      "disable-model-invocation",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect("a dry run reports the drift without writing it", () =>
  Effect.gen(function* () {
    const root = yield* workspace("explicit");

    const generated = yield* generateInvocationMetadataEffect(root, { dryRun: true });

    expect(generated.every((item) => item.changed)).toBe(true);
    expect(yield* read(join(root, "skills", "review", "SKILL.md"))).not.toContain(
      "disable-model-invocation",
    );
    expect(yield* exists(join(root, CODEX))).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect("validation reports drift as an author warning and a publication error", () =>
  Effect.gen(function* () {
    const root = yield* workspace("explicit");

    const authoring = yield* validateSkitDirectoryEffect(root, "draft", {
      assessmentContext: "author",
    });
    const publication = yield* validateSkitDirectoryEffect(root, "draft", {
      assessmentContext: "publish",
    });

    expect(authoring.diagnostics).toEqual([
      expect.objectContaining({
        code: "INVOCATION_METADATA_MISMATCH",
        severity: "warning",
        path: "skills/review/SKILL.md",
      }),
      expect.objectContaining({
        code: "INVOCATION_METADATA_MISMATCH",
        severity: "warning",
        path: CODEX_PATH,
      }),
    ]);
    expect(authoring.diagnostics[0]?.message).toContain("skit author invocation");
    expect(publication.diagnostics.every((item) => item.severity === "error")).toBe(true);
    expect(
      yield* createSkitArchiveEffect(root, join(root, "release.zip")).pipe(Effect.result),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SkitValidationFailed" },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect("acquired sources are never assessed for conformance", () =>
  Effect.gen(function* () {
    const root = yield* workspace("explicit");

    for (const context of ["retain", "project"] as const)
      expect(
        (yield* validateSkitDirectoryEffect(root, "draft", { assessmentContext: context }))
          .diagnostics,
      ).toEqual([]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect("projecting a conforming artifact rewrites nothing", () =>
  Effect.gen(function* () {
    const root = yield* workspace("explicit");
    yield* generateInvocationMetadataEffect(root);
    const skill = join(root, "skills", "review");
    const claudeBefore = yield* read(join(skill, "SKILL.md"));
    const codexBefore = yield* read(join(root, CODEX));

    yield* applyInvocationPolicyEffect(skill, "claude-code", "explicit");
    yield* applyInvocationPolicyEffect(skill, "codex", "explicit");

    expect(yield* read(join(skill, "SKILL.md"))).toBe(claudeBefore);
    expect(yield* read(join(root, CODEX))).toBe(codexBefore);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

test("conformance assessment skips a Skill whose SKILL.md is missing", () => {
  expect(
    assessInvocationConformance(
      [{ name: "review", path: "skills/review", invocation: "explicit" }],
      () => undefined,
    ),
  ).toEqual([expect.objectContaining({ harness: "codex", path: CODEX_PATH })]);
});

const REVIEW = { name: "review", path: "skills/review" } as const;
const CLAUDE = "skills/review/SKILL.md";

function resolve(
  invocation: "explicit" | "implicit" | "host-policy" | undefined,
  files: Record<string, string> = {},
) {
  return Result.getOrThrow(
    resolveDeclaredInvocation(
      { ...REVIEW, ...(invocation ? { invocation } : {}) },
      (path) => files[path],
    ),
  );
}

const claudeSkill = (value?: boolean) =>
  `---\nname: review\ndescription: Review.${value === undefined ? "" : `\ndisable-model-invocation: ${value}`}\n---\n`;
const codexMetadata = (value: boolean) => `policy:\n  allow_implicit_invocation: ${value}\n`;

test.for([
  [true, "explicit"],
  [false, "implicit"],
] as const)("reads Claude Code disable-model-invocation %s as %s", ([value, policy]) => {
  const resolved = resolve(undefined, { [CLAUDE]: claudeSkill(value) })["claude-code"];

  expect(resolved.policy).toBe(policy);
  expect(resolved.source).toEqual({
    kind: "native-metadata",
    path: CLAUDE,
    field: "disable-model-invocation",
  });
});

test.for([
  [true, "implicit"],
  [false, "explicit"],
] as const)("reads Codex allow_implicit_invocation %s as %s", ([value, policy]) => {
  const resolved = resolve(undefined, { [CODEX_PATH]: codexMetadata(value) }).codex;

  expect(resolved.policy).toBe(policy);
  expect(resolved.source).toEqual({
    kind: "native-metadata",
    path: CODEX_PATH,
    field: "policy.allow_implicit_invocation",
  });
});

test.for([
  ['"false"', "explicit"],
  ["false", "explicit"],
  ['"true"', "implicit"],
  ["true", "implicit"],
] as const)("reads OpenCode autoinvoke %s as %s", ([value, policy]) => {
  const resolved = resolve(undefined, {
    [CLAUDE]: `---\nname: review\nmetadata:\n  opencode/autoinvoke: ${value}\n---\n`,
  }).opencode;

  expect(resolved.policy).toBe(policy);
  expect(resolved.source).toEqual({
    kind: "native-metadata",
    path: CLAUDE,
    field: "metadata.opencode/autoinvoke",
  });
});

test("ignores a malformed OpenCode autoinvoke value", () => {
  const resolved = resolve(undefined, {
    [CLAUDE]: "---\nname: review\nmetadata:\n  opencode/autoinvoke: sometimes\n---\n",
  }).opencode;

  expect(resolved.policy).toBe("unspecified");
});

test("ignores non-map metadata while passively resolving OpenCode invocation", () => {
  const resolved = resolve(undefined, {
    [CLAUDE]: "---\nname: review\nmetadata: unrelated\n---\n",
  }).opencode;

  expect(resolved.policy).toBe("unspecified");
});

test("the SKIT declaration is the author's intent where one exists", () => {
  const resolved = resolve("explicit", {
    [CLAUDE]: claudeSkill(true),
    [CODEX_PATH]: codexMetadata(false),
  });

  for (const harness of ["claude-code", "codex"] as const) {
    expect(resolved[harness].policy).toBe("explicit");
    expect(resolved[harness].source).toEqual({ kind: "skit-declaration" });
    expect(resolved[harness].conformance).toEqual({ state: "conforming" });
  }
});

test("neither form declaring leaves the policy unspecified", () => {
  const resolved = resolve(undefined, { [CLAUDE]: claudeSkill() });

  expect(resolved["claude-code"]).toMatchObject({
    policy: "unspecified",
    source: { kind: "unspecified" },
    declarations: [],
    conformance: { state: "conforming" },
  });
});

test("native metadata contradicting the declaration is a defect in the artifact", () => {
  const resolved = resolve("explicit", { [CLAUDE]: claudeSkill(false) })["claude-code"];

  expect(resolved.conformance).toEqual({
    state: "non-conforming",
    path: CLAUDE,
    field: "disable-model-invocation",
    declared: "explicit",
    native: "implicit",
  });
  // Both declarations stay visible: the disagreement is reported, never silently resolved.
  expect(resolved.declarations).toEqual([
    { origin: "skit-declaration", policy: "explicit" },
    {
      origin: "native-metadata",
      policy: "implicit",
      path: CLAUDE,
      field: "disable-model-invocation",
    },
  ]);
});

test("a declaration with no native field at all is legacy and unverified", () => {
  const resolved = resolve("explicit", { [CLAUDE]: claudeSkill() });

  expect(resolved["claude-code"].conformance).toEqual({
    state: "unverified-legacy",
    path: CLAUDE,
    field: "disable-model-invocation",
  });
  expect(resolved.codex.conformance).toEqual({
    state: "unverified-legacy",
    path: CODEX_PATH,
    field: "policy.allow_implicit_invocation",
  });
});

test("host policy conforms by declaring nothing natively, and a lingering field does not", () => {
  expect(resolve("host-policy", { [CLAUDE]: claudeSkill() })["claude-code"].conformance).toEqual({
    state: "conforming",
  });
  expect(
    resolve("host-policy", { [CLAUDE]: claudeSkill(true) })["claude-code"].conformance,
  ).toMatchObject({ state: "non-conforming", declared: "host-policy", native: "explicit" });
});

test("one declaration can still yield different author defaults per Harness natively", () => {
  const resolved = resolve(undefined, {
    [CLAUDE]: claudeSkill(true),
    [CODEX_PATH]: codexMetadata(true),
  });

  expect(resolved["claude-code"].policy).toBe("explicit");
  expect(resolved.codex.policy).toBe("implicit");
});

effectIt.effect("workspace detection reports present and absent metadata", () =>
  Effect.gen(function* () {
    const root = yield* workspace(undefined);
    expect(yield* isAuthorWorkspaceEffect(root)).toBe(true);
    yield* remove(join(root, ".skit", "workspace.json"));
    expect(yield* isAuthorWorkspaceEffect(root)).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect.each(["claude-code", "codex", "missing"] as const)(
  "generation declares %s metadata failures",
  (harness) =>
    Effect.gen(function* () {
      const root = yield* workspace("explicit");
      if (harness === "missing") yield* remove(join(root, CLAUDE));
      else {
        const path = join(root, harness === "codex" ? CODEX : CLAUDE);
        yield* makeDirectory(join(root, "skills/review/agents"), { recursive: true });
        yield* write(path, harness === "codex" ? "policy: [" : "---\nname: [\n---\n");
      }
      const outcome = yield* generateInvocationMetadataEffect(root).pipe(Effect.result);
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: harness === "missing" ? "ProjectionFileMissing" : "HarnessMetadataInvalid",
        },
      });
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect.each(["read", "write"] as const)(
  "interrupting a metadata %s finalizes before any subsequent Harness or Skill mutation",
  (stage) =>
    Effect.gen(function* () {
      const root = yield* workspace("explicit");
      const descriptor = JSON.parse(yield* read(join(root, "skit.json")));
      descriptor.skills.push({ name: "later", path: "skills/later", invocation: "explicit" });
      yield* write(join(root, "skit.json"), JSON.stringify(descriptor));
      const ready = yield* Deferred.make<void>();
      const calls: string[] = [];
      let finalized = false;
      const pause = Deferred.succeed(ready, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      );
      const operation = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* generateInvocationMetadataEffect(root).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (path, options) =>
              Effect.suspend(() => {
                calls.push(`read:${path}`);
                return stage === "read" && path === join(root, CLAUDE)
                  ? pause
                  : fs.readFileString(path, options);
              }),
            makeDirectory: (path, options) =>
              Effect.suspend(() => {
                calls.push(`mkdir:${path}`);
                return fs.makeDirectory(path, options);
              }),
            writeFileString: (path, text, options) =>
              Effect.suspend(() => {
                calls.push(`write:${path}`);
                return fs.writeFileString(path, text, options).pipe(Effect.andThen(pause));
              }),
            remove: (path, options) =>
              Effect.suspend(() => {
                calls.push(`remove:${path}`);
                return fs.remove(path, options);
              }),
          }),
        );
      });
      const fiber = yield* Effect.forkChild(operation);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(finalized).toBe(true);
      expect(calls).toEqual([
        `read:${join(root, "skit.json")}`,
        `read:${join(root, CLAUDE)}`,
        ...(stage === "write"
          ? [`mkdir:${join(root, "skills/review")}`, `write:${join(root, CLAUDE)}`]
          : []),
      ]);
      expect(yield* read(join(root, CLAUDE))).toContain(
        stage === "write" ? "disable-model-invocation: true" : "description: Review.",
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

effectIt.effect("unexpected adapter exceptions remain defects", () =>
  Effect.gen(function* () {
    const root = yield* workspace("explicit");
    const adapter = invocationMetadataAdapters["claude-code"];
    const original = adapter.write;
    const defect = new Error("unexpected writer failure");
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        adapter.write = () => {
          throw defect;
        };
      }),
      () =>
        Effect.sync(() => {
          adapter.write = original;
        }),
    );
    const exit = yield* Effect.exit(generateInvocationMetadataEffect(root).pipe(Effect.result));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.hasDies(exit.cause)).toBe(true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
