// A skills.sh lock file entry is saved only through skillsShLockFileEntry, so it alone keeps
// credentials and unsafe paths out of the Library.
import { expect, it } from "vitest";
import { makeMachineId } from "../src/library/entity-ids.js";
import { skillsShLockFileEntry } from "../src/library/skills-sh-lock-file.js";

const fields = {
  machine_id: makeMachineId(),
  read_at: "2026-10-28T00:00:00.000Z",
  lock_path: "/home/story/.agents/.skill-lock.json",
  lock_version: 3,
  lock_scope: "global" as const,
  lock_content_hash: `sha256:${"0".repeat(64)}` as const,
  source: "https://user:token@github.com/acme/skills.git",
  source_type: "github",
  source_url: "https://user:token@github.com/acme/skills",
  source_base_url: "https://token@skills.example.com",
  ref: "https://user:token@github.com/acme/skills#main",
  skill_name: "review",
  content_agreement: "agrees" as const,
  original_entry: { source: "acme/skills" },
};

it("strips credentials from every source claim", () => {
  const entry = skillsShLockFileEntry(fields);
  expect([entry.source, entry.source_url, entry.source_base_url, entry.ref]).toEqual([
    "https://github.com/acme/skills.git",
    "https://github.com/acme/skills",
    "https://skills.example.com",
    "https://github.com/acme/skills#main",
  ]);
  expect(entry.lock_path).toEqual({ value: fields.lock_path });
});

it("keeps a safe skill path and drops an unsafe one", () => {
  expect(skillsShLockFileEntry({ ...fields, skill_path: "skills/review" }).skill_path).toBe(
    "skills/review",
  );
  for (const skill_path of ["../outside", "/etc", "skills\\review", ""])
    expect(skillsShLockFileEntry({ ...fields, skill_path })).not.toHaveProperty("skill_path");
});

it("hashes the original entry independently of key order", () => {
  const a = skillsShLockFileEntry({ ...fields, original_entry: { a: 1, b: 2 } });
  const b = skillsShLockFileEntry({ ...fields, original_entry: { b: 2, a: 1 } });
  expect(a.original_entry_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(a.original_entry_digest).toBe(b.original_entry_digest);
});
