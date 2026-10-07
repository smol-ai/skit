import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { LibraryStore } from "../src/index.js";
import { join } from "node:path";
import { expect } from "vitest";
import { readClaudeListingSnapshot } from "../src/harnesses/skill-listing/claude.js";
import { NativeLibraryFixture, nativeLibraryLayer } from "./helpers/listing-fixture.js";

it.effect(
  "Claude discovery reads settings once, follows scope, excludes explicit-only and remains independent of native CLI",
  () =>
    Effect.gen(function* () {
      const f = yield* NativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const state = yield* (yield* LibraryStore).load;
      const root = join(f.home, ".claude");
      const project = join(f.root, "project");
      yield* fs.makeDirectory(join(root, "skills", "visible"), { recursive: true });
      yield* fs.makeDirectory(join(project, ".claude", "skills", "hidden"), { recursive: true });
      yield* fs.writeFileString(
        join(root, "skills", "visible", "SKILL.md"),
        "---\nname: visible\ndescription: Read metadata\nwhen_to_use: When requested\n---\nBody",
      );
      yield* fs.writeFileString(
        join(project, ".claude", "skills", "hidden", "SKILL.md"),
        "---\nname: hidden\ndescription: hidden\ndisable-model-invocation: true\n---\nBody",
      );
      yield* fs.writeFileString(
        join(root, "settings.json"),
        JSON.stringify({ model: "user-model", skillListingMaxDescChars: 30 }),
      );
      yield* fs.writeFileString(
        join(project, ".claude", "settings.json"),
        JSON.stringify({ model: "project-model" }),
      );
      yield* fs.writeFileString(
        join(project, ".claude", "settings.local.json"),
        JSON.stringify({ model: "local-model", skillOverrides: { visible: "name-only" } }),
      );
      yield* fs.symlink(join(f.root, "missing"), join(root, "skills", "broken"));
      const pluginRoot = join(f.root, "plugin");
      yield* fs.makeDirectory(join(pluginRoot, "skills", "tool"), { recursive: true });
      yield* fs.writeFileString(
        join(pluginRoot, "skills", "tool", "SKILL.md"),
        "---\nname: tool\ndescription: Plugin skill\n---\nBody",
      );
      yield* fs.makeDirectory(join(root, "plugins"), { recursive: true });
      yield* fs.writeFileString(
        join(root, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: { "plug@market": [{ scope: "user", installPath: pluginRoot }] },
        }),
      );
      yield* fs.writeFileString(
        join(root, "settings.json"),
        JSON.stringify({
          model: "user-model",
          skillListingMaxDescChars: 30,
          enabledPlugins: { "plug@market": true },
          skillOverrides: { "plug:tool": "off" },
        }),
      );
      const options = {
        cwd: project,
        home: f.home,
        configHome: join(f.home, ".config"),
        overrides: {},
      };
      const snapshot = yield* readClaudeListingSnapshot(state, options);
      expect(snapshot.budget).toMatchObject({ _tag: "Estimated", limit: 8000 });
      expect(snapshot.entries).toHaveLength(2);
      expect(snapshot.entries.find((e) => e.name === "plug:tool")?.description).toBe(
        "Plugin skill",
      );
      expect(snapshot.entries[0]?.description).toBe("");
      expect("settings" in snapshot ? snapshot.settings?.model : null).toBe("local-model");
      const override = yield* readClaudeListingSnapshot(state, options).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SLASH_COMMAND_TOOL_CHAR_BUDGET: "500",
              ANTHROPIC_MODEL: "explicit-model",
            }),
          ),
        ),
      );
      expect(override.budget).toMatchObject({
        _tag: "Estimated",
        limit: 500,
        model: "explicit-model",
        unit: "characters",
        fidelity: "bounded",
      });
      for (const [model, fraction, expected] of [
        ["opus", 0.01, 40000],
        ["claude-haiku-4-5", 0.01, 8000],
        ["sonnet", 0.02, 80000],
      ] as const) {
        yield* fs.writeFileString(
          join(project, ".claude", "settings.local.json"),
          JSON.stringify({ model, skillListingBudgetFraction: fraction }),
        );
        const measured = yield* readClaudeListingSnapshot(state, options);
        expect(measured.budget).toMatchObject({ _tag: "Estimated", limit: expected });
      }
      const invalid = yield* readClaudeListingSnapshot(state, options).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ SLASH_COMMAND_TOOL_CHAR_BUDGET: "invalid" }),
          ),
        ),
      );
      expect(invalid.budget).toMatchObject({ _tag: "Unavailable" });
      yield* fs.writeFileString(join(project, ".claude", "settings.local.json"), "invalid json");
      const malformed = yield* readClaudeListingSnapshot(state, options);
      expect(malformed.budget).toMatchObject({ _tag: "Unavailable" });
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      Effect.provide(nativeLibraryLayer),
    ),
);

it.effect("nested discovery uses root shared settings, then local settings and alias pins", () =>
  Effect.gen(function* () {
    const f = yield* NativeLibraryFixture;
    const fs = yield* FileSystem.FileSystem;
    const state = yield* (yield* LibraryStore).load;
    const project = join(f.root, "project");
    const nested = join(project, "nested");
    yield* fs.makeDirectory(join(project, ".git"), { recursive: true });
    yield* fs.makeDirectory(join(project, ".claude"), { recursive: true });
    yield* fs.makeDirectory(nested);
    yield* fs.makeDirectory(join(f.home, ".claude"), { recursive: true });
    yield* fs.writeFileString(
      join(f.home, ".claude", "settings.json"),
      JSON.stringify({ model: "haiku" }),
    );
    const shared = join(project, ".claude", "settings.json");
    yield* fs.writeFileString(shared, JSON.stringify({ model: "opus" }));
    const options = {
      cwd: nested,
      home: f.home,
      configHome: join(f.home, ".config"),
      overrides: {},
    };
    const snapshot = yield* readClaudeListingSnapshot(state, options);
    expect(snapshot.budget).toMatchObject({ _tag: "Estimated", model: "opus", limit: 40000 });
    expect("settings" in snapshot ? snapshot.settings.modelSource : null).toBe(shared);
    const local = join(project, ".claude", "settings.local.json");
    yield* fs.writeFileString(local, JSON.stringify({ model: "sonnet" }));
    const localSnapshot = yield* readClaudeListingSnapshot(state, options);
    expect("settings" in localSnapshot ? localSnapshot.settings.modelSource : null).toBe(local);
    const pinned = yield* readClaudeListingSnapshot(state, options).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-haiku-4-5" }),
        ),
      ),
    );
    expect(pinned.budget).toMatchObject({
      _tag: "Estimated",
      model: "claude-haiku-4-5",
      limit: 8000,
    });
    expect("settings" in pinned ? pinned.settings.modelSource : null).toBe(
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
    );
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    Effect.provide(nativeLibraryLayer),
  ),
);
