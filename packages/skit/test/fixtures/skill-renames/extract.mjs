// Regenerates these fixtures from a clone of github.com/mattpocock/skills (MIT, see LICENSE).
// Usage: node extract.mjs <path-to-mattpocock-skills.git>
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.argv[2];
if (!repo) throw new Error("Usage: node extract.mjs <path-to-mattpocock-skills.git>");
const here = dirname(fileURLToPath(import.meta.url));
const git = (...args) => execFileSync("git", ["--git-dir", repo, ...args], { encoding: "buffer" });

// Every pure skill rename in the history: only the folder and the `name` field change.
const cases = [
  {
    name: "review-to-code-review",
    commit: "14c13c5",
    from: "skills/in-progress/review",
    to: "skills/engineering/code-review",
  },
  {
    name: "domain-model-to-grill-with-docs",
    commit: "fb847c6",
    from: "skills/engineering/domain-model",
    to: "skills/engineering/grill-with-docs",
  },
  {
    name: "setup-git-guardrails-to-git-guardrails-claude-code",
    commit: "b81729c",
    from: "setup-git-guardrails",
    to: "git-guardrails-claude-code",
  },
];

const files = (revision, folder) =>
  git("ls-tree", "-r", "--name-only", revision, "--", `${folder}/`)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ path, bytes: git("show", `${revision}:${path}`) }));

for (const { name, ...entry } of cases) {
  const commit = git("rev-parse", entry.commit).toString().trim();
  const title = git("log", "-1", "--format=%s", commit).toString().trim();
  const directory = join(here, name);
  rmSync(directory, { recursive: true, force: true });
  for (const [side, revision, folder] of [
    ["before", `${commit}^`, entry.from],
    ["after", commit, entry.to],
  ])
    for (const file of files(revision, folder)) {
      const target = join(directory, side, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
  writeFileSync(
    join(directory, "case.json"),
    `${JSON.stringify({ source: "https://github.com/mattpocock/skills", ...entry, commit, title }, null, 2)}\n`,
  );
}
writeFileSync(join(here, "LICENSE"), git("show", "HEAD:LICENSE"));
