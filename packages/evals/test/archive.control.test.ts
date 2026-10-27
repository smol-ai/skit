import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { messyHomeFixture } from "../src/fixtures.ts";
import { buildReport } from "../src/observe.ts";
import { createRunRoot, removeRunRoot } from "../src/run-root.ts";

it("archives internal links so they work after the live run is removed", async () => {
  const archive = mkdtempSync(join(tmpdir(), "skit-archive-test-"));
  const run = createRunRoot("archive-control");
  vi.stubEnv("SKIT_EVAL_ARCHIVE_DIR", archive);
  try {
    const { archiveRun } = await import("../src/archive.ts");
    const fixture = messyHomeFixture(run.home);
    mkdirSync(join(run.home, "links"));
    symlinkSync("../dotfiles/skills/standup", join(run.home, "links/relative"));
    symlinkSync("/external/missing", join(run.home, "links/external"));
    // A link to the old home itself must also relocate without recursing through it.
    symlinkSync(run.home, join(run.home, "links/home"));
    const report = await buildReport({
      run,
      caseId: "archive-control",
      prompt: "control",
      permissions: { writable: [], network: false },
      outcome: {
        codexVersion: "control",
        model: "control",
        command: [],
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
        events: [],
      },
      fixture,
      verify: () => [],
      skitTarballSha256: "control",
      skitGitHead: "control",
      skitGitDirty: false,
    });
    const destination = archiveRun(run, report);
    removeRunRoot(run);
    const home = join(destination, "home");
    const original = fixture.userFiles.find(
      (file) => file.path === "dotfiles/skills/standup/SKILL.md",
    );
    expect(original).toBeDefined();
    const document = readFileSync(join(home, "dotfiles/skills/standup/SKILL.md"), "utf8");
    expect(readFileSync(join(home, ".claude/skills/standup/SKILL.md"), "utf8")).toBe(document);
    expect(readFileSync(join(home, "links/relative/SKILL.md"), "utf8")).toBe(document);
    expect(readFileSync(join(home, "links/home/dotfiles/skills/standup/SKILL.md"), "utf8")).toBe(
      document,
    );
    expect(readlinkSync(join(home, "links/external"))).toBe("/external/missing");
    expect(report.observation.userLinks[0]?.target).toBe(join(run.home, "dotfiles/skills/standup"));
  } finally {
    vi.unstubAllEnvs();
    removeRunRoot(run);
    rmSync(archive, { recursive: true, force: true });
  }
});
