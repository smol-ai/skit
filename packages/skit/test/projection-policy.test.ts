import { join } from "node:path";
import { parse } from "yaml";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";
import { applyInvocationPolicyEffect, overrideInvocationIntent } from "../src/projection/policy.js";
import { skitLayer } from "../src/platform/layer.js";

const makeDirectory = (path: string) => FileSystem.FileSystem.use((fs) => fs.makeDirectory(path));
const makeTemporaryDirectory = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "skit-projection-policy-" }),
);
const read = (path: string) => FileSystem.FileSystem.use((fs) => fs.readFileString(path));
const write = (path: string, contents: string) =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(path, contents));
const exists = (path: string) => FileSystem.FileSystem.use((fs) => fs.exists(path));

const frontmatter = (text: string) => parse(text.match(/^---\r?\n([\s\S]*?)^---/m)?.[1] ?? "");

function skill(frontmatter = "name: review\ndescription: Review.") {
  return Effect.gen(function* () {
    const directory = yield* makeTemporaryDirectory;
    yield* write(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n# Review\n`);
    return directory;
  });
}

it.effect("projects explicit-only intent into native Harness settings", () =>
  Effect.gen(function* () {
    const claude = yield* skill();
    const codex = yield* skill();
    const opencode = yield* skill();

    yield* applyInvocationPolicyEffect(claude, "claude-code", "explicit");
    yield* applyInvocationPolicyEffect(codex, "codex", "explicit");
    yield* applyInvocationPolicyEffect(opencode, "opencode", "explicit");

    expect(yield* read(join(claude, "SKILL.md"))).toContain("disable-model-invocation: true");
    expect(parse(yield* read(join(codex, "agents", "openai.yaml")))).toMatchObject({
      policy: { allow_implicit_invocation: false },
    });
    expect(frontmatter(yield* read(join(opencode, "SKILL.md")))).toMatchObject({
      metadata: { "opencode/autoinvoke": "false" },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("projects implicit intent as portable OpenCode metadata", () =>
  Effect.gen(function* () {
    const directory = yield* skill("name: review\nmetadata:\n  other: keep");

    yield* applyInvocationPolicyEffect(directory, "opencode", "implicit");

    expect(frontmatter(yield* read(join(directory, "SKILL.md")))).toMatchObject({
      metadata: { other: "keep", "opencode/autoinvoke": "true" },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("OpenCode host policy removes only its invocation constraint", () =>
  Effect.gen(function* () {
    const directory = yield* skill(
      'name: review\nmetadata:\n  opencode/autoinvoke: "false"\n  other: keep',
    );
    yield* applyInvocationPolicyEffect(
      directory,
      "opencode",
      "explicit",
      overrideInvocationIntent("host-policy"),
    );

    expect(frontmatter(yield* read(join(directory, "SKILL.md")))).toEqual({
      name: "review",
      metadata: { other: "keep" },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("OpenCode rejects a non-map metadata field on write with a tagged failure", () =>
  Effect.gen(function* () {
    for (const metadata of ["", "value", "[value]"]) {
      const directory = yield* skill(`name: review\nmetadata: ${metadata}`);
      const result = yield* applyInvocationPolicyEffect(directory, "opencode", "explicit").pipe(
        Effect.result,
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "HarnessMetadataInvalid", kind: "OpenCode metadata" },
      });
    }
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("OpenCode overwrites an authored implicit value and preserves CRLF", () =>
  Effect.gen(function* () {
    const directory = yield* makeTemporaryDirectory;
    yield* write(
      join(directory, "SKILL.md"),
      '---\r\nname: review\r\nmetadata: { opencode/autoinvoke: "true", other: keep }\r\n---\r\n# Review\r\n',
    );

    yield* applyInvocationPolicyEffect(
      directory,
      "opencode",
      "implicit",
      overrideInvocationIntent("explicit"),
    );

    const projected = yield* read(join(directory, "SKILL.md"));
    expect(projected).not.toMatch(/(?<!\r)\n/);
    expect(frontmatter(projected)).toMatchObject({
      metadata: { "opencode/autoinvoke": "false", other: "keep" },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a declaration overrides stale native metadata", () =>
  Effect.gen(function* () {
    const claude = yield* skill(
      "name: review\ndescription: Review.\ndisable-model-invocation: false",
    );
    const codex = yield* skill();
    yield* makeDirectory(join(codex, "agents"));
    yield* write(
      join(codex, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );

    yield* applyInvocationPolicyEffect(claude, "claude-code", "explicit");
    yield* applyInvocationPolicyEffect(codex, "codex", "explicit");

    expect(yield* read(join(claude, "SKILL.md"))).toContain("disable-model-invocation: true");
    expect(yield* read(join(codex, "agents", "openai.yaml"))).toContain(
      "allow_implicit_invocation: false",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an undeclared skill keeps its native metadata byte-identical", () =>
  Effect.gen(function* () {
    const claude = yield* skill(
      "name: review\ndescription: Review.\ndisable-model-invocation: false",
    );
    const codex = yield* skill();
    yield* makeDirectory(join(codex, "agents"));
    yield* write(
      join(codex, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );
    const before = yield* read(join(claude, "SKILL.md"));

    yield* applyInvocationPolicyEffect(claude, "claude-code", undefined);
    yield* applyInvocationPolicyEffect(codex, "codex", undefined);

    expect(yield* read(join(claude, "SKILL.md"))).toBe(before);
    expect(yield* read(join(codex, "agents", "openai.yaml"))).toBe(
      "policy:\n  allow_implicit_invocation: true\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("declared host policy removes native invocation metadata", () =>
  Effect.gen(function* () {
    const claude = yield* skill(
      "name: review\ndescription: Review.\ndisable-model-invocation: true",
    );
    const codex = yield* skill();
    yield* makeDirectory(join(codex, "agents"));
    yield* write(
      join(codex, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );

    yield* applyInvocationPolicyEffect(claude, "claude-code", "host-policy");
    yield* applyInvocationPolicyEffect(codex, "codex", "host-policy");

    expect(yield* read(join(claude, "SKILL.md"))).toBe(
      "---\nname: review\ndescription: Review.\n---\n# Review\n",
    );
    expect(yield* exists(join(codex, "agents", "openai.yaml"))).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("host policy keeps unrelated Codex metadata", () =>
  Effect.gen(function* () {
    const codex = yield* skill();
    yield* makeDirectory(join(codex, "agents"));
    yield* write(
      join(codex, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n  other: keep\n",
    );

    yield* applyInvocationPolicyEffect(codex, "codex", "host-policy");

    expect(yield* read(join(codex, "agents", "openai.yaml"))).toBe("policy:\n  other: keep\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a local override still wins over the author's declaration", () =>
  Effect.gen(function* () {
    const claude = yield* skill(
      "name: review\ndescription: Review.\ndisable-model-invocation: true",
    );

    yield* applyInvocationPolicyEffect(
      claude,
      "claude-code",
      "explicit",
      overrideInvocationIntent("host-policy"),
    );

    expect(yield* read(join(claude, "SKILL.md"))).toBe(
      "---\nname: review\ndescription: Review.\n---\n# Review\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a projection override wins over authored settings", () =>
  Effect.gen(function* () {
    const codex = yield* skill();
    yield* makeDirectory(join(codex, "agents"));
    yield* write(
      join(codex, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );

    yield* applyInvocationPolicyEffect(
      codex,
      "codex",
      "implicit",
      overrideInvocationIntent("explicit"),
    );

    expect(parse(yield* read(join(codex, "agents", "openai.yaml")))).toMatchObject({
      policy: { allow_implicit_invocation: false },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("host policy leaves native files unchanged", () =>
  Effect.gen(function* () {
    const directory = yield* skill();
    const before = yield* read(join(directory, "SKILL.md"));

    yield* applyInvocationPolicyEffect(
      directory,
      "claude-code",
      "explicit",
      overrideInvocationIntent("host-policy"),
    );

    expect(yield* read(join(directory, "SKILL.md"))).toBe(before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("safely replaces an empty Claude invocation value", () =>
  Effect.gen(function* () {
    const directory = yield* skill("name: review\ndisable-model-invocation:");

    yield* applyInvocationPolicyEffect(
      directory,
      "claude-code",
      "implicit",
      overrideInvocationIntent("explicit"),
    );

    const projected = yield* read(join(directory, "SKILL.md"));
    expect(projected).toContain("disable-model-invocation: true");
    expect(projected).toContain("---\n# Review");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("adds frontmatter when an explicit Claude override has none", () =>
  Effect.gen(function* () {
    const directory = yield* makeTemporaryDirectory;
    yield* write(join(directory, "SKILL.md"), "# Review\n");

    yield* applyInvocationPolicyEffect(
      directory,
      "claude-code",
      undefined,
      overrideInvocationIntent("explicit"),
    );

    expect(yield* read(join(directory, "SKILL.md"))).toBe(
      "---\ndisable-model-invocation: true\n---\n# Review\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("writes new Codex metadata in canonical block style", () =>
  Effect.gen(function* () {
    const directory = yield* skill();

    yield* applyInvocationPolicyEffect(directory, "codex", "explicit");

    expect(yield* read(join(directory, "agents", "openai.yaml"))).toBe(
      "policy:\n  allow_implicit_invocation: false\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not infer model invocation from dependency-only trigger modes", () =>
  Effect.gen(function* () {
    const directory = yield* skill();
    const before = yield* read(join(directory, "SKILL.md"));

    yield* applyInvocationPolicyEffect(directory, "claude-code", undefined);

    expect(yield* read(join(directory, "SKILL.md"))).toBe(before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("preserves long frontmatter scalars on one line", () =>
  Effect.gen(function* () {
    const description =
      "Use this skill when the user asks for a thorough code review of a branch, a pull request, or any set of pending changes that need scrutiny.";
    const directory = yield* skill(`name: review\ndescription: ${description}`);

    yield* applyInvocationPolicyEffect(directory, "claude-code", "explicit");

    expect(yield* read(join(directory, "SKILL.md"))).toContain(`description: ${description}\n`);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not treat an inline separator as the frontmatter delimiter", () =>
  Effect.gen(function* () {
    const directory = yield* skill("name: review\ndescription: separator is ---\nother: x");

    yield* applyInvocationPolicyEffect(directory, "claude-code", "explicit");

    const projected = yield* read(join(directory, "SKILL.md"));
    expect(projected).toContain("description: separator is ---\n");
    expect(projected).toContain("other: x\n");
    expect(parse(projected.match(/^---\n([\s\S]*?)^---$/m)?.[1] ?? "")).toMatchObject({
      description: "separator is ---",
      other: "x",
      "disable-model-invocation": true,
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("adds policy inside empty frontmatter", () =>
  Effect.gen(function* () {
    const directory = yield* makeTemporaryDirectory;
    yield* write(join(directory, "SKILL.md"), "---\n---\n# Review\n");

    yield* applyInvocationPolicyEffect(directory, "claude-code", "explicit");

    expect(yield* read(join(directory, "SKILL.md"))).toBe(
      "---\ndisable-model-invocation: true\n---\n# Review\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("preserves CRLF throughout Claude frontmatter", () =>
  Effect.gen(function* () {
    const directory = yield* makeTemporaryDirectory;
    yield* write(join(directory, "SKILL.md"), "---\r\nname: review\r\n---\r\n# Review\r\n");

    yield* applyInvocationPolicyEffect(directory, "claude-code", "explicit");

    const projected = yield* read(join(directory, "SKILL.md"));
    expect(projected).not.toMatch(/(?<!\r)\n/);
    expect(projected).toContain("disable-model-invocation: true\r\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
