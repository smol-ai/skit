import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { SyncConflicted, type SyncConflictDetail } from "@smolai/skit-core/library/sync";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { renderSyncConflicts } from "../src/library/sync/conflict.js";
import { presentLibrarySync } from "../src/library/sync/present.js";
import { renderBlocks } from "../src/terminal/blocks.js";

test("sync results and failures share the explanation, consequence and exact remote command", () => {
  const detail: SyncConflictDetail = {
    _tag: "CollectionChanged",
    key: "collection:review-tools",
    label: "Review tools",
    resolution: "take-remote",
  };
  const [conflict] = renderSyncConflicts([detail]);
  if (conflict === undefined) throw new Error("Missing conflict presentation");
  expect(presentLibrarySync({ status: "conflicted", conflict_details: [detail] })).toContainEqual(
    conflict,
  );
  expect(classifyFailure(new SyncConflicted({ conflicts: [detail] })).explanation).toContainEqual(
    conflict,
  );
  const text = renderBlocks([conflict], { color: false, width: 40 });
  expect(text.replace(/\s+/g, " ")).toContain(
    "This replaces this device's choices for the Collection.",
  );
  expect(text.match(/collection:review-tools/g)).toHaveLength(1);
  expect(text).toContain("skit sync --apply --take-remote 'collection:review-tools'");
});

test("remote resolution commands pass stored keys as one literal shell argument", () => {
  const key = "record:review '$(printf injected)' ; printf injected";
  const text = renderBlocks(
    renderSyncConflicts([{ _tag: "RecordChanged", key, resolution: "take-remote" }]),
    { color: false, width: 40 },
  );
  const command = text.split("\n").find((line) => line.trimStart().startsWith("skit sync"));
  expect(command).toBeDefined();
  const args = execFileSync("/bin/sh", ["-c", `skit() { printf '%s\\0' "$@"; }; ${command}`], {
    encoding: "utf8",
  })
    .split("\0")
    .slice(0, -1);
  expect(args).toEqual(["sync", "--apply", "--take-remote", key]);
});

test("same-name destination collisions offer an exact command for each distinct skill", () => {
  const skills = [
    { id: "skill-first", name: "review", collection: "Team tools" },
    { id: "skill-second", name: "review", collection: "Team tools" },
  ];
  const text = renderBlocks(
    renderSyncConflicts([
      {
        _tag: "DestinationCollision",
        key: "destination:review",
        resolution: "keep-enabled",
        skills,
      },
    ]),
    { color: false, width: 40 },
  );
  for (const skill of skills) {
    expect(text).toContain(`skit sync --apply --keep-enabled '${skill.id}'`);
    expect(text.match(new RegExp(skill.id, "g"))).toHaveLength(1);
  }
  expect(text).not.toContain("<skill-id>");
  expect(text.replace(/\s+/g, " ")).toContain("Both stay in the Library.");
});

test("a local-only conflict never offers a remote or keep-enabled command", () => {
  const text = renderBlocks(
    renderSyncConflicts([
      {
        _tag: "CollectionChanged",
        key: "collection:private-edits",
        label: "Private edits",
        resolution: "local",
      },
    ]),
    { color: false, width: 100 },
  );
  expect(text.replace(/\s+/g, " ")).toContain("cannot be taken remotely");
  expect(text).not.toContain("skit sync --apply");
  expect(text).not.toContain("collection:private-edits");
});

test("several choices explain that their flags must be combined in one command", () => {
  const text = renderBlocks(
    renderSyncConflicts([
      { _tag: "SkillChanged", key: "skill:first", name: "first", resolution: "take-remote" },
      { _tag: "SkillChanged", key: "skill:second", name: "second", resolution: "take-remote" },
    ]),
    { color: false, width: 100 },
  );
  expect(text.replace(/\s+/g, " ")).toContain(
    "combine the chosen resolution flags in one skit sync --apply command",
  );
  expect(text).toContain("--take-remote 'skill:first'");
  expect(text).toContain("--take-remote 'skill:second'");
});
