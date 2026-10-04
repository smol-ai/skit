import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildInfo } from "./build-info.mjs";

const require = createRequire(resolve("packages/cli/package.json"));
const { gt } = require("semver");
const execute = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", ...options });

/** Retry only the read-only published install, never publication or promotion. */
export async function retryInstall(
  install,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return install();
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export async function releaseCli({
  run = execute,
  fetchRegistry = fetch,
  sleep,
  environment = process.env,
} = {}) {
  const metadata = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
  const build = buildInfo(metadata, { ...environment, SKIT_RELEASE: "1" });
  const channel = metadata.version.match(/-(alpha|beta|rc)\./)?.[1] ?? "latest";
  const response = await fetchRegistry("https://registry.npmjs.org/@smolai%2fskit", {
    signal: AbortSignal.timeout(15_000),
  });
  let registry;
  if (response.status === 404) registry = {};
  else if (response.ok) registry = await response.json();
  else throw new Error(`Registry preflight failed: ${response.status}`);
  const published = registry.versions?.[metadata.version];
  const current = registry["dist-tags"]?.[channel];
  if (current && current !== metadata.version && !gt(metadata.version, current))
    throw new Error(`Refusing to move ${channel} backwards from ${current}`);
  // The release stamp must never leak into independently versioned server builds.
  run("pnpm", ["--filter", "@smolai/skit...", "build"], {
    stdio: "inherit",
    env: { ...environment, SKIT_RELEASE: "1" },
  });
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts"], { cwd: "packages/cli" }),
  )[0];
  const tarball = resolve("packages/cli", packed.filename);
  const temporary = mkdtempSync(join(tmpdir(), "skit-release-"));
  let index = 0;
  async function smoke(spec, publishedInstall) {
    const prefix = join(temporary, `install-${index++}`);
    const install = () =>
      run("npm", [
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-online",
        spec,
      ]);
    if (publishedInstall) await retryInstall(install, sleep);
    else install();
    const entry = join(prefix, "node_modules", "@smolai", "skit", "bin", "skit.js");
    const local = JSON.parse(run(process.execPath, [entry, "--version", "--json"]));
    const report = JSON.parse(
      run(process.execPath, [entry, "version", "--json"], {
        env: {
          ...environment,
          XDG_STATE_HOME: join(temporary, "state"),
          SKIT_NPM_REGISTRY: "http://127.0.0.1:1",
        },
      }),
    );
    if (
      local.data.version !== metadata.version ||
      report.data.build.kind !== "release" ||
      report.data.build.commit !== build.commit
    )
      throw new Error("Packed release metadata mismatch");
  }
  try {
    await smoke(tarball, false);
    if (published) {
      // Resume only the exact tarball built from this tag, not merely matching claims.
      const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
      if (published.dist?.integrity !== integrity)
        throw new Error("Published version differs from this artifact; bump the version.");
    } else {
      run("npm", ["publish", tarball, "--tag", "staging", "--access", "public", "--provenance"], {
        stdio: "inherit",
        env: environment,
      });
    }
    await smoke(`${metadata.name}@${metadata.version}`, true);
    if (current !== metadata.version)
      run("npm", ["dist-tag", "add", `${metadata.name}@${metadata.version}`, channel], {
        stdio: "inherit",
        env: environment,
      });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await releaseCli();
