import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function releaseFixture(version = "0.2.0-alpha.1") {
  const previous = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "skit-release-fixture-"));
  mkdirSync(join(root, "packages/cli"), { recursive: true });
  const metadata = { name: "@smolai/skit", version };
  writeFileSync(join(root, "packages/cli/package.json"), JSON.stringify(metadata));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  git("tag", `${metadata.name}@${version}`);
  process.chdir(root);
  return {
    root,
    metadata,
    git,
    close: () => {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
