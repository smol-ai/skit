import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { baseCaseFixture } from "../src/fixtures.ts";
import { observe } from "../src/observe.ts";
import { createRunRoot, removeRunRoot, type RunRoot } from "../src/run-root.ts";
import { agentPath, installSkitPackage, linkTools } from "../src/skit-package.ts";

// The control proves the verifier reads real skit state, using the same packaged skit, PATH and
// home an agent gets, before any model usage is spent on trusting it.
const controlRuns: RunRoot[] = [];
afterAll(() => controlRuns.forEach(removeRunRoot));

function controlRun(): RunRoot {
  const run = createRunRoot("control");
  controlRuns.push(run);
  linkTools(run, installSkitPackage());
  return run;
}

function skit(run: RunRoot, ...args: string[]): void {
  execFileSync("skit", args, {
    cwd: run.home,
    env: { HOME: run.home, PATH: agentPath(run), TMPDIR: run.tmp, SKIT_NO_UPDATE_CHECK: "1" },
    stdio: "ignore",
  });
}

describe("observe", () => {
  it("reports an untouched machine as having no Library and intact user files", () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);

    const observation = observe(run.home, fixture);

    expect(observation.library.exists).toBe(false);
    expect(observation.userFiles.map((file) => file.status)).toEqual(["intact"]);
  });

  it("detects a changed user file", () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);
    writeFileSync(join(run.home, fixture.userFiles[0]!.path), "rewritten\n");

    expect(observe(run.home, fixture).userFiles.map((file) => file.status)).toEqual(["changed"]);
  });

  it("reads the Library and its projections from skit's own state", () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);
    skit(run, "add", join(run.home, ".claude/skills/release-notes"));
    skit(run, "enable", "release-notes");

    const observation = observe(run.home, fixture);

    expect(observation.library.exists).toBe(true);
    expect(observation.library.skills).toEqual(["release-notes"]);
    expect(observation.library.projections.map((projection) => projection.target).sort()).toEqual([
      "agents",
      "claude",
    ]);
  });
});
