import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import { resolveSkitSourceEffect } from "../src/acquisition/sources.js";
import { readPluginUnitsEffect } from "../src/acquisition/plugin-manifests.js";
import { skitLayer } from "../src/platform/layer.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plugin-declarations-" });
  const write = (path: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(dirname(join(root, path)), { recursive: true });
      yield* fs.writeFileString(join(root, path), text);
    });
  const skill = (path: string, name = "review", body = "Review this change.") =>
    write(`${path}/SKILL.md`, `---\nname: ${name}\ndescription: Review changes.\n---\n\n${body}\n`);
  const json = (path: string, value: unknown) => write(path, JSON.stringify(value));
  const discover = (previousSkillPaths?: readonly string[]) =>
    resolveSkitSourceEffect(root, { verbatimOnly: true, previousSkillPaths });
  return { fs, root, write, skill, json, discover };
});

it.effect(
  "uses manifest membership rather than recursively importing plugin implementation examples",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.skill("plugins/tools/skills/review");
      yield* f.skill("plugins/tools/skills/review/examples/nested", "nested");
      yield* f.skill("plugins/tools/examples/demo", "demo");
      yield* f.json("plugins/tools/.claude-plugin/plugin.json", { name: "tools" });
      assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
        "plugins/tools/skills/review",
      ]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("merges identical declared mirrors while retaining distinct plugin Skills", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.skill("skills/review");
    yield* f.skill(".github/plugins/tools/skills/review");
    yield* f.skill(".github/plugins/tools/skills/deploy", "deploy");
    yield* f.json(".github/plugins/tools/.claude-plugin/plugin.json", { name: "tools" });
    assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
      "skills/review",
      ".github/plugins/tools/skills/deploy",
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "preserves previous mirror paths and discovers new members without retaining deleted ones",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.skill("skills/review");
      yield* f.skill("plugins/tools/skills/review");
      yield* f.skill("plugins/tools/legacy", "legacy");
      yield* f.skill("plugins/tools/skills/added", "added");
      yield* f.json("plugins/tools/.claude-plugin/plugin.json", { name: "tools" });
      assert.deepStrictEqual(
        (yield* f.discover([
          "plugins/tools/skills/review",
          "plugins/tools/legacy",
          "plugins/tools/deleted",
        ])).observedSkillPaths,
        ["plugins/tools/legacy", "plugins/tools/skills/review", "plugins/tools/skills/added"],
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not merge different same-name Skills across plugin namespaces", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const name of ["legal", "finance", "commercial"]) {
      yield* f.skill(`plugins/${name}/skills/review`, "review", `Review ${name}.`);
      yield* f.json(`plugins/${name}/.claude-plugin/plugin.json`, { name });
    }
    const error = yield* f.discover().pipe(Effect.flip);
    assert.include(error.message, "Select the plugin or Skill directory explicitly");
    assert.include(error.message, "plugins/finance/skills/review");
    assert.include(error.message, "plugins/commercial/skills/review");
    if (error._tag === "PluginSkillConflict") {
      assert.deepStrictEqual(error.directories, [
        "plugins/commercial",
        "plugins/finance",
        "plugins/legal",
      ]);
      assert.deepStrictEqual(
        error.locators,
        ["commercial", "finance", "legal"].map((name) => join(f.root, "plugins", name)),
      );
    }
    const selected = yield* resolveSkitSourceEffect(join(f.root, "plugins/legal"), {
      verbatimOnly: true,
    });
    assert.deepStrictEqual(selected.observedSkillPaths, ["skills/review"]);
    // Equal names and bytes alone do not establish an alias between separate packages.
    for (const name of ["legal", "finance", "commercial"]) {
      yield* f.skill(`plugins/${name}/skills/review`, "review", "Identical instructions");
      yield* f.json(`plugins/${name}/.claude-plugin/plugin.json`, { name: "same-plugin-name" });
    }
    assert.strictEqual((yield* f.discover().pipe(Effect.flip))._tag, "PluginSkillConflict");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepts string and array direct Skill declarations in addition to default skills", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const path of ["tools/skills/default", "tools/direct", "tools/extras/other"])
      yield* f.skill(path, path.split("/").at(-1));
    yield* f.json("tools/.claude-plugin/plugin.json", {
      name: "tools",
      skills: ["./direct", "./extras"],
    });
    assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
      "tools/direct",
      "tools/extras/other",
      "tools/skills/default",
    ]);
    yield* f.json("tools/.claude-plugin/plugin.json", { name: "tools", skills: "./direct" });
    assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
      "tools/direct",
      "tools/skills/default",
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps shared-root marketplace selections separate in the declaration facts", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.skill("skills/review");
    yield* f.skill("legal", "legal");
    yield* f.skill("finance", "finance");
    yield* f.json(".claude-plugin/marketplace.json", {
      plugins: [
        { name: "legal", source: ".", skills: "./legal" },
        { name: "finance", source: ".", skills: ["./finance"] },
      ],
    });
    const units = yield* readPluginUnitsEffect(f.root, [f.root]);
    assert.deepStrictEqual(
      units.map((unit) => ({
        name: unit.name,
        skills: unit.skills.map((path) => path.slice(f.root.length + 1)),
      })),
      [
        { name: "legal", skills: ["legal"] },
        { name: "finance", skills: ["finance"] },
      ],
    );
    assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
      "skills/review",
      "finance",
      "legal",
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "uses metadata.pluginRoot and supports marketplace entries without plugin manifests",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.skill("bundles/tools/skills/review");
      yield* f.json(".claude-plugin/marketplace.json", {
        metadata: { pluginRoot: "./bundles" },
        plugins: [{ name: "tools", source: "tools" }],
      });
      assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
        "bundles/tools/skills/review",
      ]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reports strict:false conflicts without blocking unrelated Skill imports", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.skill("tools/skills/review");
    yield* f.json("tools/.claude-plugin/plugin.json", { name: "tools" });
    yield* f.json(".claude-plugin/marketplace.json", {
      plugins: [{ name: "tools", source: "./tools", strict: false, skills: "./skills" }],
    });
    const discovered = yield* f.discover();
    assert.deepStrictEqual(discovered.observedSkillPaths, ["tools/skills/review"]);
    assert.include(discovered.diagnostics?.[0]?.message ?? "", "strict:false");
    const error = yield* resolveSkitSourceEffect(f.root, {
      verbatimOnly: true,
      strictPluginManifests: true,
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "PluginManifestInvalid");
    assert.include(error.message, "strict:false");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const scenario of [
  { path: "templates/.claude-plugin/marketplace.json", text: "{}" },
  { path: ".claude-plugin/marketplace.json", text: "{}" },
  { path: ".agents/plugins/marketplace.json", text: "invalid JSON" },
  {
    path: ".claude-plugin/marketplace.json",
    text: '{"plugins":[{"name":"missing","source":"./missing"}]}',
  },
  { path: ".claude-plugin/marketplace.json", text: '{"plugins":[{"name":"missing-source"}]}' },
  { path: "tools/.claude-plugin/plugin.json", text: '{"name":"tools","skills":"./missing"}' },
  {
    path: "tools/.claude-plugin/plugin.json",
    text: '{"name":"tools","skills":"./skills/review/SKILL.md"}',
  },
  { path: "tools/.claude-plugin/plugin.json", text: '{"name":"tools","skills":123}' },
]) {
  it.effect(
    `keeps valid Skills when an unselected declaration is invalid: ${scenario.path} ${scenario.text}`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.skill("skills/standalone", "standalone");
        yield* f.skill("tools/skills/review");
        yield* f.write(scenario.path, scenario.text);
        const result = yield* f.discover();
        assert.deepStrictEqual(result.observedSkillPaths?.toSorted(), [
          "skills/standalone",
          "tools/skills/review",
        ]);
        assert.isAtLeast(result.diagnostics?.length ?? 0, 1);
        assert.strictEqual(result.diagnostics?.[0]?.code, "plugin-manifest-invalid");
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

it.effect("retains standalone agent and developer Skills alongside a repository-root plugin", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.skill("skills/review");
    yield* f.skill(".claude/skills/agent", "agent");
    yield* f.skill("dev-skills/develop", "develop");
    yield* f.json(".claude-plugin/plugin.json", { name: "tools" });
    assert.deepStrictEqual((yield* f.discover()).observedSkillPaths?.toSorted(), [
      ".claude/skills/agent",
      "dev-skills/develop",
      "skills/review",
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reads Codex local marketplace declarations and portable nested manifests", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.skill("codex/extra", "codex");
    yield* f.skill("portable/skills/review");
    yield* f.json(".agents/plugins/marketplace.json", {
      plugins: [{ name: "codex", source: { source: "local", path: "./codex" } }],
    });
    yield* f.json("codex/.codex-plugin/plugin.json", { name: "codex", skills: "./extra" });
    yield* f.json("portable/plugin.json", {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "portable",
    });
    assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
      "codex/extra",
      "portable/skills/review",
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "recognizes single-Skill plugins and leaves no-Skill plugins out of standalone discovery",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.skill("single");
      yield* f.json("single/.claude-plugin/plugin.json", { name: "single" });
      yield* f.skill("hooks-only/examples/check", "check");
      yield* f.json("hooks-only/.claude-plugin/plugin.json", { name: "hooks-only" });
      assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, [
        "hooks-only/examples/check",
        "single",
      ]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("rejects escaped manifest and discovery-document file links before reading them", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const outside = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-outside-source-" });
    yield* f.fs.writeFileString(join(outside, "plugin.json"), '{"name":"outside"}');
    yield* f.fs.makeDirectory(join(f.root, ".claude-plugin"));
    yield* f.fs.symlink(join(outside, "plugin.json"), join(f.root, ".claude-plugin/plugin.json"));
    const manifestError = yield* f.discover().pipe(Effect.flip);
    assert.include(manifestError.message, "Link escapes the Source");
    yield* f.fs.remove(join(f.root, ".claude-plugin/plugin.json"));
    yield* f.fs.symlink(join(outside, "plugin.json"), join(f.root, "SKILL.md"));
    const documentError = yield* f.discover().pipe(Effect.flip);
    assert.include(documentError.message, "Link escapes the Source");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "materializes manifest-selected contained directory links at their original member paths",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.skill(".claude/skills/review");
      yield* f.fs.makeDirectory(join(f.root, "tools/skills"), { recursive: true });
      yield* f.fs.symlink("../../.claude/skills/review", join(f.root, "tools/skills/review"));
      yield* f.json("tools/.claude-plugin/plugin.json", { name: "tools" });
      const retained = yield* f.discover(["tools/skills/review"]);
      assert.deepStrictEqual(retained.observedSkillPaths, ["tools/skills/review"]);
      assert.strictEqual(
        (yield* f.fs.stat(join(retained.originalRoot, "tools/skills/review"))).type,
        "Directory",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(retained.originalRoot, "tools/skills/review/SKILL.md")),
        yield* f.fs.readFileString(join(f.root, ".claude/skills/review/SKILL.md")),
      );
      const normalized = yield* resolveSkitSourceEffect(f.root, {
        previousSkillPaths: ["tools/skills/review"],
      });
      assert.isTrue(yield* f.fs.exists(join(normalized.root, "skills/review/SKILL.md")));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps declared SKIT descriptor precedence inside plugin directories", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.skill("skills/standalone", "standalone");
    yield* f.skill("plugins/tools/skills/review");
    yield* f.json("plugins/tools/skit.json", {
      slug: "tools",
      skills: [{ name: "review", path: "skills/review" }],
    });
    const resolved = yield* f.discover();
    assert.strictEqual(resolved.descriptorKind, "declared");
    assert.strictEqual(resolved.root, join(f.root, "plugins/tools"));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "uses portable package membership rather than adding Codex compatibility overlay directories",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.skill("tools/skills/review");
      yield* f.skill("tools/legacy/extra", "extra");
      yield* f.json("tools/plugin.json", {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "tools",
        extensions: { "com.openai": {} },
      });
      yield* f.json("tools/.codex-plugin/plugin.json", { name: "tools", skills: "./legacy" });
      assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, ["tools/skills/review"]);
      yield* f.write("tools/.codex-plugin/plugin.json", "invalid ignored overlay");
      assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, ["tools/skills/review"]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "resolves nested marketplaces relative to their own root and honors explicit root selections",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.skill("nested/skills/default", "default");
      yield* f.skill("nested/selected", "selected");
      yield* f.json("nested/.claude-plugin/marketplace.json", {
        plugins: [{ name: "selected", source: ".", skills: "./selected" }],
      });
      assert.deepStrictEqual((yield* f.discover()).observedSkillPaths, ["nested/selected"]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
