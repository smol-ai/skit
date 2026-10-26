import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyRecommendedSetup,
  buildMachine,
  cases,
  messyHomeCase,
  type EvalCase,
} from "../src/cases.ts";
import { baseCaseFixture } from "../src/fixtures.ts";
import { observe, preservationFailures } from "../src/observe.ts";
import { startLocalRegistry, type LocalRegistry } from "../src/registry.ts";
import { createRunRoot, removeRunRoot, type RunRoot } from "../src/run-root.ts";
import { installSkitPackage, linkTools, runSkit } from "../src/skit-package.ts";

// The control proves the verifier reads real skit state, using the same packaged skit, PATH and
// home an agent gets, before any model usage is spent on trusting it.
const controlRuns: RunRoot[] = [];
let registry: LocalRegistry;
beforeAll(async () => {
  registry = await startLocalRegistry();
});
afterAll(async () => {
  controlRuns.forEach(removeRunRoot);
  await registry.close();
});

function controlRun(): RunRoot {
  const run = createRunRoot("control");
  controlRuns.push(run);
  linkTools(run, installSkitPackage());
  return run;
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

  it("detects a skill folder skit does not record", () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);
    cpSync(
      join(run.home, ".claude/skills/release-notes"),
      join(run.home, ".agents/skills/release-notes"),
      { recursive: true },
    );

    expect(preservationFailures(observe(run.home, fixture))).toContain(
      "skill folder skit does not record: .agents/skills/release-notes",
    );
  });

  it("reads the Library and its projections from skit's own state", async () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);
    await runSkit(run, "add", join(run.home, ".claude/skills/release-notes"));
    await runSkit(run, "enable", "release-notes");

    const observation = observe(run.home, fixture);

    expect(observation.library.exists).toBe(true);
    expect(observation.library.skills).toEqual(["release-notes"]);
    expect(observation.library.projections.map((projection) => projection.target).sort()).toEqual([
      "agents",
      "claude",
    ]);
  });
});

function judge(
  evalCase: EvalCase,
  run: RunRoot,
  fixture: ReturnType<EvalCase["fixture"]>,
  finalMessage: string | null,
) {
  const observation = observe(run.home, fixture);
  return [
    ...preservationFailures(observation),
    ...evalCase.verify({ observation, finalMessage, issued: registry.issued }),
  ];
}

// Every case's checks accept what a correct agent does and reject an agent that does nothing, so
// a live pass means the task was done.
describe.each(cases)("$id checks", (evalCase) => {
  it("pass the reference solution", async () => {
    const run = controlRun();
    const fixture = buildMachine(evalCase, run.home);
    const message = await evalCase.reference(
      { home: run.home, registry: registry.origin },
      (...args) => runSkit(run, ...args),
    );

    expect(judge(evalCase, run, fixture, message)).toEqual([]);
  });

  it("fail an agent that does nothing", () => {
    const run = controlRun();
    const fixture = buildMachine(evalCase, run.home);

    expect(judge(evalCase, run, fixture, "Done.")).not.toEqual([]);
  });
});

describe("setup-messy checks", () => {
  it("fail setup that replaces the user's symlinked skill with a copy", async () => {
    const run = controlRun();
    const fixture = messyHomeCase.fixture(run.home);
    await applyRecommendedSetup((...args) => runSkit(run, ...args), {
      workDir: join(run.home, "Work"),
      duplicates: "retire-aliases",
    });

    expect(judge(messyHomeCase, run, fixture, null)).toEqual(
      expect.arrayContaining(["user link replaced: .claude/skills/standup"]),
    );
  });

  it("fail setup that leaves out ~/Work", async () => {
    const run = controlRun();
    const fixture = messyHomeCase.fixture(run.home);
    await applyRecommendedSetup((...args) => runSkit(run, ...args));

    expect(judge(messyHomeCase, run, fixture, null)).toEqual(["skit does not scan ~/Work"]);
  });
});
