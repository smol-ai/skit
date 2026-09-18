import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const bin = join(process.cwd(), "bin", "skit.js");

test("previews, adds, and projects a descriptorless skill collection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skit-source-e2e-"));
  const source = join(workspace, "skills");
  const home = join(workspace, "home");
  const codexRoot = join(workspace, "codex");
  for (const [directory, name] of [
    ["code-review", "code-review"],
    ["release-notes", "release-notes"],
  ]) {
    await mkdir(join(source, directory), { recursive: true });
    await writeFile(
      join(source, directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: A realistic descriptorless Agent Skill fixture.\n---\n\n# ${name}\n`,
    );
  }
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [bin, ...args, "--home", home, "--codex-root", codexRoot, "--json"],
      { encoding: "utf8" },
    );

  const preview = run("add", source, "--list");
  expect(preview.status, preview.stderr).toBe(0);
  const previewData = JSON.parse(preview.stdout).data;
  expect(previewData.kind).toBe("plain");
  expect(previewData.skills).toHaveLength(2);
  expect(existsSync(join(home, "state.json"))).toBe(false);

  const added = run("add", source);
  expect(added.status, added.stderr).toBe(0);
  const sourceData = JSON.parse(added.stdout).data;
  expect(sourceData.skills).toHaveLength(2);
  expect(sourceData).toMatchObject({
    collection_id: expect.any(String),
    retained_version_id: expect.any(String),
    snapshot_digest: expect.stringMatching(/^sha256:/),
  });

  const enabledCollection = run("enable", sourceData.collection_id, "--all", "--for", "codex");
  expect(enabledCollection.status, enabledCollection.stderr).toBe(0);
  const enabledCollectionData = JSON.parse(enabledCollection.stdout).data;
  expect(enabledCollectionData.skills).toEqual(["code-review", "release-notes"]);
  const enabledSkillIds = enabledCollectionData.bindings[0].skills;
  expect(enabledSkillIds).toEqual([
    expect.stringMatching(/^skill_[0-9a-z]{26}$/),
    expect.stringMatching(/^skill_[0-9a-z]{26}$/),
  ]);
  expect(enabledCollectionData.bindings).toEqual([
    expect.objectContaining({
      collection_id: sourceData.collection_id,
      harness: "codex",
      skills: enabledSkillIds,
    }),
  ]);
  expect(await readFile(join(codexRoot, "release-notes", "SKILL.md"), "utf8")).toContain(
    "# release-notes",
  );

  const listed = run("list");
  expect(listed.status, listed.stderr).toBe(0);
  const listing = JSON.parse(listed.stdout).data;
  const collection = listing.collections.find(
    (entry: { collection_id: string }) => entry.collection_id === sourceData.collection_id,
  );
  expect(collection).toBeDefined();
  expect(listing.bindings).toContainEqual(
    expect.objectContaining({
      collection_id: collection.collection_id,
      harness: "codex",
      skills: expect.arrayContaining(enabledSkillIds),
    }),
  );

  const disabledCollection = run("disable", sourceData.collection_id, "--all", "--for", "codex");
  expect(disabledCollection.status, disabledCollection.stderr).toBe(0);
  const disabledCollectionData = JSON.parse(disabledCollection.stdout).data;
  expect(disabledCollectionData.skills).toEqual(["code-review", "release-notes"]);
  expect(disabledCollectionData.bindings).toEqual([]);
  expect(existsSync(join(codexRoot, "code-review"))).toBe(false);
  expect(existsSync(join(codexRoot, "release-notes"))).toBe(false);
});

test("retains GitHub collection identity through add, enable, and list", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skit-github-identity-e2e-"));
  const fixture = join(workspace, "fixture");
  const home = join(workspace, "home");
  const codexRoot = join(workspace, "codex");
  await mkdir(join(fixture, "code-review"), { recursive: true });
  await writeFile(
    join(fixture, "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: Review code.\n---\n\n# Code Review\n",
  );
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
  ]) {
    const committed = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    expect(committed.status, committed.stderr).toBe(0);
  }
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [bin, ...args, "--home", home, "--codex-root", codexRoot, "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${fixture}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/mattpocock/skills",
        },
      },
    );

  const added = run("add", "https://github.com/mattpocock/skills");
  expect(added.status, added.stderr).toBe(0);
  const addedCollection = JSON.parse(added.stdout).data;
  expect(addedCollection.collection_id).toEqual(expect.any(String));

  const enabled = run("enable", addedCollection.collection_id, "--all", "--for", "codex");
  expect(enabled.status, enabled.stderr).toBe(0);
  const listed = run("list");
  expect(listed.status, listed.stderr).toBe(0);
  const listing = JSON.parse(listed.stdout).data;
  const collection = listing.collections.find(
    (entry: { display_id?: string }) => entry.display_id === "mattpocock/skills",
  );
  expect(collection).toBeDefined();
  const codeReview = collection.skills.find(
    (skill: { name: string }) => skill.name === "code-review",
  );
  expect(codeReview).toBeDefined();
  expect(listing.bindings).toContainEqual(
    expect.objectContaining({
      collection_id: collection!.collection_id,
      harness: "codex",
      skills: [codeReview!.skill_id],
    }),
  );

  const persisted = await readFile(join(home, "state.json"), "utf8");
  const ownership = await readFile(join(codexRoot, "code-review", ".skit-ownership.json"), "utf8");
  expect(
    JSON.parse(persisted).collections.some(
      (entry: { display_name?: string }) => entry.display_name === "mattpocock/skills",
    ),
  ).toBe(true);
  expect(ownership).toContain(codeReview!.skill_id);
});
