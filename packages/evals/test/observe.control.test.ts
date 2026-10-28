import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyRecommendedSetup,
  baseCase,
  cases,
  messyHomeCase,
  type EvalCase,
} from "../src/cases.ts";
import { baseCaseFixture } from "../src/fixtures.ts";
import { observe, backupFailures } from "../src/observe.ts";
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
  it("reports an untouched machine as having no Library and intact user files", async () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);

    const observation = await observe(run.home, fixture);

    expect(observation.library.exists).toBe(false);
    expect(observation.userFiles.map((file) => file.status)).toEqual(["intact"]);
  });

  it("detects a changed user file", async () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);
    writeFileSync(join(run.home, fixture.userFiles[0]!.path), "rewritten\n");

    expect((await observe(run.home, fixture)).userFiles.map((file) => file.status)).toEqual([
      "changed",
    ]);
  });

  it("detects a skill folder skit does not record", async () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);
    cpSync(
      join(run.home, ".claude/skills/release-notes"),
      join(run.home, ".agents/skills/release-notes"),
      { recursive: true },
    );

    expect(backupFailures(await observe(run.home, fixture))).toContain(
      "skill folder skit does not record: .agents/skills/release-notes",
    );
  });

  it("reads the Library and its installed skills from skit's own state", async () => {
    const run = controlRun();
    const fixture = baseCaseFixture(run.home);
    await runSkit(run, "add", join(run.home, ".claude/skills/release-notes"));
    await runSkit(run, "enable", "release-notes");

    const observation = await observe(run.home, fixture);

    expect(observation.library.exists).toBe(true);
    expect(observation.library.skills).toEqual(["release-notes"]);
    expect(
      observation.library.installedSkills.map((installedSkill) => installedSkill.target).sort(),
    ).toEqual(["agents", "claude"]);
  });
});

async function judge(
  evalCase: EvalCase,
  run: RunRoot,
  fixture: ReturnType<EvalCase["fixture"]>,
  finalMessage: string | null,
) {
  const observation = await observe(run.home, fixture);
  return [
    ...backupFailures(observation),
    ...evalCase.verify({ observation, finalMessage, issued: registry.issued }),
  ];
}

// Every case's checks accept what a correct agent does and reject an agent that does nothing, so
// a live pass means the task was done.
describe.each(cases)("$id checks", (evalCase) => {
  it("pass the reference solution", async () => {
    const run = controlRun();
    const fixture = evalCase.fixture(run.home);
    const message = await evalCase.reference(
      { home: run.home, registry: registry.origin },
      (...args) => runSkit(run, ...args),
    );

    expect(await judge(evalCase, run, fixture, message)).toEqual([]);
  });

  it("fail an agent that does nothing", async () => {
    const run = controlRun();
    const fixture = evalCase.fixture(run.home);

    expect(await judge(evalCase, run, fixture, "Done.")).not.toEqual([]);
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

    expect(await judge(messyHomeCase, run, fixture, null)).toEqual(
      expect.arrayContaining(["user link replaced: .claude/skills/standup"]),
    );
  });

  it("fail setup that leaves out ~/Work", async () => {
    const run = controlRun();
    const fixture = messyHomeCase.fixture(run.home);
    await applyRecommendedSetup((...args) => runSkit(run, ...args));

    expect(await judge(messyHomeCase, run, fixture, null)).toEqual(["skit does not scan ~/Work"]);
  });
});

describe("setup verifier rejects broken final states", () => {
  it("rejects fabricated installed records without retained content or copies", async () => {
    const run = controlRun();
    const fixture = baseCase.fixture(run.home);
    mkdirSync(join(run.home, ".skit"));
    writeFileSync(
      join(run.home, ".skit", "state.json"),
      JSON.stringify({
        skills: [{ name: "release-notes" }],
        installedSkills: ["agents", "claude"].map((target) => ({
          target,
          path: join(run.home, target === "agents" ? ".agents" : ".claude", "skills/release-notes"),
          status: "installed",
        })),
      }),
    );
    expect(await judge(baseCase, run, fixture, "Done.")).not.toEqual([]);
  });

  it.each([
    "missing copy",
    "changed copy",
    "missing marker",
    "missing retention",
    "changed retention",
  ])("rejects a reference solution with %s", async (damage) => {
    const run = controlRun();
    const fixture = baseCase.fixture(run.home);
    await baseCase.reference({ home: run.home, registry: registry.origin }, (...args) =>
      runSkit(run, ...args),
    );
    const copy = join(run.home, ".agents/skills/release-notes");
    if (damage === "missing copy") rmSync(copy, { recursive: true });
    if (damage === "changed copy") writeFileSync(join(copy, "SKILL.md"), "broken\n");
    if (damage === "missing marker") rmSync(join(copy, ".skit-ownership.json"));
    if (damage === "missing retention")
      rmSync(join(run.home, ".skit/originals"), { recursive: true });
    if (damage === "changed retention") {
      const state = JSON.parse(readFileSync(join(run.home, ".skit/state.json"), "utf8"));
      const hash = state.collection_versions[0].hash.slice(7);
      writeFileSync(
        join(run.home, ".skit/originals", hash.slice(0, 2), hash, "SKILL.md"),
        "broken\n",
      );
    }
    expect(await judge(baseCase, run, fixture, "Done.")).not.toEqual([]);
  });
});
