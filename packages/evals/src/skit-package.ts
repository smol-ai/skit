import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import { runsDir, type RunRoot } from "./run-root.ts";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli");

/** The packaged skit an agent gets, identified by the tarball it was installed from. */
export interface SkitPackage {
  readonly executable: string;
  readonly tarballSha256: string;
  readonly gitHead: string;
  /** Whether the packages in the build had uncommitted changes, so it is not exactly `gitHead`. */
  readonly gitDirty: boolean;
}

let installed: SkitPackage | undefined;

/**
 * Pack the built CLI and install it globally into a cache prefix, the way `npm i -g` would. The
 * agent then gets the published file set (bundle, README, contracts), not the repository source.
 * Requires `pnpm --filter @smolai/skit build` first; `prepack` is skipped so packing never rebuilds.
 */
export function installSkitPackage(): SkitPackage {
  if (installed) return installed;
  if (!existsSync(join(cliRoot, "dist/src/main.js"))) {
    throw new Error("packages/cli is not built; run `pnpm --filter @smolai/skit build` first");
  }
  const packDir = join(runsDir, ".cache", "pack");
  mkdirSync(packDir, { recursive: true });
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: cliRoot,
      encoding: "utf8",
    }),
  ) as Array<{ filename: string }>;
  const packedPath = join(packDir, packed!.filename);
  const tarballSha256 = createHash("sha256").update(readFileSync(packedPath)).digest("hex");
  // Content-addressed so concurrent and repeated runs share one install per build.
  const tarball = join(packDir, `${tarballSha256}.tgz`);
  renameSync(packedPath, tarball);
  const prefix = join(runsDir, ".cache", `skit-${tarballSha256.slice(0, 16)}`);
  const executable = join(prefix, "bin", "skit");
  if (!existsSync(executable)) {
    execFileSync(
      "npm",
      ["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", tarball],
      { stdio: "ignore" },
    );
  }
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: cliRoot,
    encoding: "utf8",
  }).trim();
  const gitDirty =
    execFileSync("git", ["status", "--porcelain", "--", ".", "../skit"], {
      cwd: cliRoot,
      encoding: "utf8",
    }).trim() !== "";
  installed = { executable, tarballSha256, gitHead, gitDirty };
  return installed;
}

/**
 * Put exactly `node` and `skit` in the run's bin directory. The agent's PATH is this directory plus
 * the system directories, so the developer's own tools (codex, claude, global npm packages) are
 * not reachable from inside a trial.
 */
export function linkTools(run: RunRoot, skit: SkitPackage | undefined): void {
  symlinkSync(supportedNode(), join(run.bin, "node"));
  if (skit) symlinkSync(skit.executable, join(run.bin, "skit"));
}

/**
 * The Node the agent gets must satisfy the CLI's `engines`. Otherwise skit crashes on import and
 * the trial measures the harness, not skit; the first live run did exactly that, and the agent
 * escaped by prepending `/opt/homebrew/bin` to PATH.
 */
function supportedNode(): string {
  const node = process.env.SKIT_EVAL_NODE ?? process.execPath;
  const range = (
    JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { engines: { node: string } }
  ).engines.node;
  const version = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
  if (!satisfies(version, range)) {
    throw new Error(
      `skit requires Node ${range}; ${node} is ${version}. Set SKIT_EVAL_NODE to a supported node.`,
    );
  }
  return node;
}

export function agentPath(run: RunRoot): string {
  return [run.bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}
