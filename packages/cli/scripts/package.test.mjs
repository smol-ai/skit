import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const cleanEnvironment = (cache) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "NODE_PATH" && !name.toLowerCase().startsWith("npm_config_"),
    ),
  ),
  npm_config_cache: cache,
  XDG_STATE_HOME: join(cache, "state"),
  SKIT_NPM_REGISTRY: "http://127.0.0.1:1",
});

test("the packed CLI installs and runs without workspace dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "skit-package-test-"));
  try {
    const environment = cleanEnvironment(join(root, "npm-cache"));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const shell = process.platform === "win32";
    const packOutput = execFileSync(
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      {
        encoding: "utf8",
        env: environment,
        shell,
      },
    );
    const [packed] = JSON.parse(packOutput);
    assert.ok(packed);
    const packedPaths = packed.files.map(({ path }) => path).sort();
    // Check the built artifact; release prepack builds it separately.
    const runtimeFiles = [
      "LICENSE",
      "bin/skit.js",
      "dist/src/main.js",
      "package.json",
      "dist/src/storybook/index.js",
      "dist/src/storybook/index.d.ts",
      "dist/src/storybook/contracts.d.ts",
      "dist/src/storybook/frame.d.ts",
      "dist/src/terminal/contracts.d.ts",
      "dist/src/terminal/status.d.ts",
    ];
    if (existsSync("dist/src/storybook/index.js.LEGAL.txt"))
      runtimeFiles.push("dist/src/storybook/index.js.LEGAL.txt");
    runtimeFiles.push(
      ...readdirSync("dist/src/storybook/chunks").map(
        (name) => `dist/src/storybook/chunks/${name}`,
      ),
    );
    // esbuild emits this file only when bundled dependencies contain legal comments.
    // Effect 4 no longer bundles fast-check, so its notices may be absent.
    if (existsSync("dist/src/main.js.LEGAL.txt")) runtimeFiles.push("dist/src/main.js.LEGAL.txt");
    assert.deepEqual(
      packedPaths.filter((path) => !path.startsWith("contracts/")),
      runtimeFiles.sort(),
    );
    assert.ok(packedPaths.includes("contracts/command-manifest.json"));
    assert.ok(packedPaths.includes("contracts/skit.version.v1.json"));

    const tarball = join(root, packed.filename);
    const prefix = join(root, "prefix");
    execFileSync(
      npm,
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { stdio: "pipe", env: environment, shell },
    );

    const linkedExecutable =
      process.platform === "win32" ? join(prefix, "skit.cmd") : join(prefix, "bin", "skit");
    assert.ok(existsSync(linkedExecutable));
    const installedEntrypoint = join(
      prefix,
      "lib",
      "node_modules",
      "@smolai",
      "skit",
      "bin",
      "skit.js",
    );
    const output = execFileSync(process.execPath, [installedEntrypoint, "version", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnvironment(join(root, "runtime-npm-cache")),
    });
    const report = JSON.parse(output);
    assert.equal(report.schema, "skit.version.v2");
    assert.equal(report.data.version, packed.version);
    assert.equal(report.data.build.version, packed.version);
    assert.equal(report.data.build.kind, "dev");
    const local = execFileSync(process.execPath, [installedEntrypoint, "--version", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnvironment(join(root, "runtime-npm-cache")),
    });
    assert.deepEqual(JSON.parse(local), {
      schema: "skit.version.v1",
      data: { version: packed.version },
    });

    // Storybook supplies the optional Effect peer, just as a consuming app does.
    const modules = join(prefix, "lib", "node_modules");
    symlinkSync(
      dirname(fileURLToPath(import.meta.resolve("effect/package.json"))),
      join(modules, "effect"),
      "dir",
    );
    symlinkSync(modules, join(root, "node_modules"), "dir");
    const client = join(root, "client.mjs");
    writeFileSync(
      client,
      `
      import assert from "node:assert/strict";
      import { Effect } from "effect";
      import * as stories from "@smolai/skit/storybook";
      const index = stories.outputStories.findIndex(story => story.key === "library-sync/merged");
      assert.ok(index >= 0);
      const frame = stories.renderOutputFrame(index, stories.defaultTerminalEnvironment);
      assert.ok(frame.stdout.length + frame.stderr.length > 0);
      const story = stories.journeyStories.find(story => story.name === "library-sync/fresh-device");
      assert.ok(story);
      const recorded = await Effect.runPromise(story.record);
      const frames = recorded.frames(stories.defaultTerminalEnvironment);
      assert.ok(frames.length > 8);
      assert.ok(frames.some(frame => frame.status === "Downloading 3 Skill copies · 0/3"));
      assert.ok(recorded.transcript(stories.defaultTerminalEnvironment, process.cwd()).includes(story.name));
      assert.equal("OutputStory" in stories, false);
      assert.equal("events" in recorded, false);
    `,
    );
    execFileSync(process.execPath, [client], { cwd: root, env: environment, stdio: "pipe" });

    // The declaration closure must also work with only the public package and its peers.
    mkdirSync(join(modules, "@types"), { recursive: true });
    symlinkSync(
      dirname(fileURLToPath(import.meta.resolve("@types/node/package.json"))),
      join(modules, "@types", "node"),
      "dir",
    );
    const typedClient = join(root, "client.mts");
    writeFileSync(
      typedClient,
      `
      import type { Effect } from "effect";
      import { journeyStories, renderOutputFrame, defaultTerminalEnvironment,
        type JourneyRecording, type TerminalFrame } from "@smolai/skit/storybook";
      const recording: Effect.Effect<JourneyRecording> = journeyStories[0].record;
      const frame: TerminalFrame | undefined = renderOutputFrame(0, defaultTerminalEnvironment);
      void recording; void frame;
    `,
    );
    execFileSync(
      resolve("../../node_modules/.bin/tsc"),
      [
        "--ignoreConfig",
        "--noEmit",
        "--module",
        "nodenext",
        "--target",
        "es2023",
        "--types",
        "node",
        "--typeRoots",
        join(modules, "@types"),
        typedClient,
      ],
      { cwd: root, env: environment, stdio: "pipe", shell },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
