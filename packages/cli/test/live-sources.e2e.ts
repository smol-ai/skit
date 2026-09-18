import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect, test } from "vitest";

const bin = join(process.cwd(), "bin", "skit.js");
const live = process.env.SKIT_LIVE_E2E === "1";
const registrySource = process.env.SKIT_LIVE_REGISTRY_SOURCE;

function fixture() {
  return mkdtemp(join(tmpdir(), "skit-live-e2e-"));
}

function command(workspace: string, args: string[]) {
  const home = join(workspace, "home");
  const codexRoot = join(workspace, "codex");
  const result = spawnSync(
    process.execPath,
    [bin, ...args, "--home", home, "--codex-root", codexRoot, "--json"],
    {
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
      killSignal: "SIGKILL",
    },
  );
  expect(
    result.status,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"),
  ).toBe(0);
  return { data: JSON.parse(result.stdout).data, codexRoot };
}

test.skipIf(!live)("adds and projects a skill from a real GitHub collection", async () => {
  const workspace = await fixture();
  try {
    const source = "https://github.com/mattpocock/skills";
    const preview = command(workspace, ["add", source, "--list"]).data;
    expect(preview.displayId).toBe("mattpocock/skills");
    expect(preview.skills.length).toBeGreaterThan(0);

    const added = command(workspace, ["add", source]).data;
    const skill = added.skills[0];
    expect(skill.ref).toMatch(/^github:mattpocock\/skills#/);
    const { codexRoot } = command(workspace, ["enable", skill.ref, "--for", "codex"]);
    expect(existsSync(join(codexRoot, skill.name, "SKILL.md"))).toBe(true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test.skipIf(!live || !registrySource)("adds and projects a real Registry SKIT", async () => {
  const workspace = await fixture();
  try {
    const added = command(workspace, ["add", registrySource!]).data;
    expect(added.skills.length).toBeGreaterThan(0);
    const skill = added.skills[0];
    const { codexRoot } = command(workspace, ["enable", skill.ref, "--for", "codex"]);
    expect(existsSync(join(codexRoot, skill.name, "SKILL.md"))).toBe(true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
