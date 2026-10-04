import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildInfo } from "./build-info.mjs";

const metadata = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
const build = buildInfo(metadata, { ...process.env, SKIT_RELEASE: "1" });
const require = createRequire(resolve("packages/cli/package.json"));
const { gt } = require("semver");
const channel = metadata.version.match(/-(alpha|beta|rc)\./)?.[1] ?? "latest";
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", ...options });
// Treat transport/auth errors as failures, never as proof that a version is unused.
const response = await fetch(`https://registry.npmjs.org/@smolai%2fskit`);
let registry;
if (response.status === 404) registry = {};
else if (response.ok) registry = await response.json();
else throw new Error(`Registry preflight failed: ${response.status}`);
if (registry.versions?.[metadata.version])
  throw new Error("Version already published; bump it before retrying.");
const current = registry["dist-tags"]?.[channel];
if (current && !gt(metadata.version, current))
  throw new Error(`Refusing to move ${channel} backwards or sideways from ${current}`);
run("pnpm", ["build"], { stdio: "inherit", env: { ...process.env, SKIT_RELEASE: "1" } });
const packed = JSON.parse(
  run("npm", ["pack", "--json", "--ignore-scripts"], { cwd: "packages/cli" }),
)[0];
const tarball = resolve("packages/cli", packed.filename);
const temporary = mkdtempSync(join(tmpdir(), "skit-release-"));
function smoke(spec) {
  run("npm", [
    "install",
    "--prefix",
    temporary,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    spec,
  ]);
  const entry = join(temporary, "node_modules", "@smolai", "skit", "bin", "skit.js");
  const local = JSON.parse(run(process.execPath, [entry, "--version", "--json"]));
  const report = JSON.parse(run(process.execPath, [entry, "version", "--json"]));
  if (
    local.data.version !== metadata.version ||
    report.data.build.kind !== "release" ||
    report.data.build.commit !== build.commit
  )
    throw new Error("Packed release metadata mismatch");
}
try {
  smoke(tarball);
  run("npm", ["publish", tarball, "--tag", "staging", "--access", "public", "--provenance"], {
    stdio: "inherit",
  });
  smoke(`${metadata.name}@${metadata.version}`);
  run("npm", ["dist-tag", "add", `${metadata.name}@${metadata.version}`, channel], {
    stdio: "inherit",
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
