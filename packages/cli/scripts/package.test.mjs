import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const packOutput = execFileSync(npm, ["pack", "--json", "--pack-destination", root], {
      encoding: "utf8",
      env: environment,
      shell,
    });
    const [packed] = JSON.parse(packOutput);
    assert.ok(packed);
    const packedPaths = packed.files.map(({ path }) => path).sort();
    const runtimeFiles = ["LICENSE", "bin/skit.js", "dist/src/main.js", "package.json"];
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
