// `add` and `add --list` must describe the same verbatim acquisition for a Git Source too.
//
// Git is the one Source family `add-source-families.test.ts` cannot drive in process: acquisition
// spawns a real `git`, and the classifier only recognises `git@`, `ssh://` and `https://….git`
// forms, so a local checkout has no supported syntax of its own.
//
// This runs the real CLI as a subprocess with a `git` shim first on PATH. The shim rewrites only
// the clone URL to a disposable local repository and delegates every invocation to the real git,
// so clone and revision resolution are real work against real history. Nothing here reaches the network, and no production
// switch exists for it: PATH is the seam.

import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { isolatedRoots } from "./helpers/isolated-library.js";

const bin = join(process.cwd(), "bin", "skit.js");
const REMOTE = "https://example.invalid/fixtures/tools.git";

/** The real git, resolved before anything is put in front of it on PATH. */
const realGit = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).status === 0 ? "git" : "";

interface AddResult {
  collection_id: string;
  retained_version_id: string;
  snapshot_digest: string;
  skills: ReadonlyArray<{ name: string; verbatim_path: string }>;
}

const AddResultDocument = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      collection_id: Schema.String,
      retained_version_id: Schema.String,
      snapshot_digest: Schema.String,
      skills: Schema.Array(Schema.Struct({ name: Schema.String, verbatim_path: Schema.String })),
    }),
  }),
);
const AddPreviewDocument = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      kind: Schema.Literals(["plain", "authored"]),
      skills: Schema.Array(Schema.Struct({ name: Schema.String, verbatim_path: Schema.String })),
    }),
  }),
);
const LibraryCountsDocument = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(4),
    collections: Schema.Array(
      Schema.Struct({
        collection_id: Schema.String,
      }),
    ),
    skills: Schema.Array(Schema.Unknown),
    retained_copies: Schema.Array(
      Schema.Struct({ retained_copy_id: Schema.String, digest: Schema.String }),
    ),
    acquisitions: Schema.Array(
      Schema.Struct({
        retained_copy_id: Schema.String,
        tracking: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("default") }),
          Schema.Struct({ kind: Schema.Literal("commit"), ref: Schema.String }),
        ]),
        selection: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("full-tree") }),
          Schema.Struct({
            kind: Schema.Literal("selected-paths"),
            paths: Schema.Array(Schema.String),
          }),
        ]),
        source_revision: Schema.optionalKey(Schema.String),
      }),
    ),
    projections: Schema.Array(Schema.Unknown),
    global_bindings: Schema.Array(Schema.Unknown),
    local_bindings: Schema.Array(Schema.Unknown),
  }),
);
const addResult = (text: string): AddResult =>
  Schema.decodeUnknownSync(AddResultDocument)(text).data;

/** A disposable local repository with a declared Descriptor and two Skills. */
async function repository(root: string, outsideSymlink = false) {
  const repo = join(root, "repo");
  await mkdir(join(repo, "skills", "review"), { recursive: true });
  await mkdir(join(repo, "skills", "audit"), { recursive: true });
  // A descriptorless subtree exercises plain Skill membership without a generated wrapper.
  await mkdir(join(repo, "imported", "code-review"), { recursive: true });
  await mkdir(join(repo, "imported", "security-review"), { recursive: true });
  await writeFile(
    join(repo, "skit.json"),
    `${JSON.stringify(
      {
        slug: "tools",
        skills: [
          { name: "review", path: "skills/review" },
          { name: "audit", path: "skills/audit" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  for (const name of ["review", "audit"])
    await writeFile(
      join(repo, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Describe exactly when this skill should be used.\n---\n\n# ${name}\n`,
    );
  await writeFile(
    join(repo, "imported", "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: Describe exactly when this skill should be used.\n---\n\n# Code Review\n",
  );
  await writeFile(
    join(repo, "imported", "security-review", "SKILL.md"),
    "---\nname: security-review\ndescription: Review security boundaries.\n---\n\n# Security Review\n",
  );
  if (outsideSymlink) await symlink("../../.claude/skills/outside", join(repo, "outside-skill"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  git("init", "-q", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "fixture",
    "--date=2026-01-02T03:04:05+00:00",
  );
  return { repo, head: git("rev-parse", "HEAD").trim() };
}

/** A `git` that rewrites one clone URL to a local path and is otherwise the real git. */
async function gitShim(root: string, repo: string) {
  const directory = join(root, "bin");
  const log = join(root, "git-invocations.jsonl");
  await mkdir(directory, { recursive: true });
  const shim = join(directory, "git");
  await writeFile(
    shim,
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const remote = ${JSON.stringify(REMOTE)};
const repo = ${JSON.stringify(repo)};
const log = ${JSON.stringify(log)};
// Only the clone target is rewritten; every other argument and subcommand is passed through.
const args = process.argv.slice(2).map((value) => (value === remote ? repo : value));
require("node:fs").appendFileSync(log, args.join("\\t") + "\\n");
const result = spawnSync(${JSON.stringify(process.env.PATH ?? "")}.split(":").map((p) => p + "/git").find((p) => require("node:fs").existsSync(p)), args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
  );
  await chmod(shim, 0o755);
  return { directory, log };
}

const gitInvocations = async (log: string): Promise<ReadonlyArray<ReadonlyArray<string>>> =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));

test.runIf(realGit)(
  "preview and add agree for a Git source, and repeat stably",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-git-parity-"));
    try {
      const fixture = await repository(root);
      const shim = await gitShim(root, fixture.repo);
      const roots = isolatedRoots(root);

      const run = (...args: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              bin,
              ...args,
              "--json",
              "--home",
              roots.home,
              "--codex-root",
              roots.codexRoot,
              "--claude-root",
              roots.claudeRoot,
              "--opencode-root",
              roots.opencodeRoot,
              "--devin-root",
              roots.devinRoots[0],
            ],
            {
              env: {
                ...process.env,
                PATH: `${shim.directory}:${process.env.PATH}`,
                SKIT_HOME: roots.home,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout!.on("data", (chunk) => (stdout += chunk));
          child.stderr!.on("data", (chunk) => (stderr += chunk));
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        });

      const preview = await run("add", REMOTE, "--list");
      expect(preview.code, preview.stderr).toBe(0);
      const previewed = Schema.decodeUnknownSync(AddPreviewDocument)(preview.stdout).data;
      expect(previewed.kind).toBe("authored");
      expect(previewed.skills.map((skill) => skill.name).sort()).toEqual(["audit", "review"]);
      // Preview retains nothing: no state, no Original, no projected bytes.
      expect(existsSync(join(roots.home, "state.json"))).toBe(false);
      expect(existsSync(join(roots.home, "originals"))).toBe(false);
      expect(
        (await gitInvocations(shim.log)).some(
          (args) => args[0] === "fetch" && args.at(-1) === "HEAD",
        ),
      ).toBe(false);

      const added = await run("add", REMOTE);
      expect(added.code, added.stderr).toBe(0);
      const entry = addResult(added.stdout);
      expect(entry.skills).toEqual(previewed.skills);
      expect(entry.skills.map((skill) => skill.name).sort()).toEqual(["audit", "review"]);

      const state = Schema.decodeUnknownSync(LibraryCountsDocument)(
        await readFile(join(roots.home, "state.json"), "utf8"),
      );
      expect(state.schemaVersion).toBe(4);
      expect(state.collections.map((item) => item.collection_id)).toEqual([entry.collection_id]);
      expect(state.retained_copies).toHaveLength(1);
      expect(state.retained_copies[0].digest).toBe(entry.snapshot_digest);
      expect(state.projections).toEqual([]);
      // A new add creates no Binding and no Projection.
      expect(state.global_bindings).toEqual([]);
      expect(state.local_bindings).toEqual([]);
      expect(existsSync(join(roots.claudeRoot, "review"))).toBe(false);

      // A fresh clone of unchanged history reuses the exact retained Version.
      const beforeRepeat = (await gitInvocations(shim.log)).length;
      const again = await run("add", REMOTE);
      expect(again.code, again.stderr).toBe(0);
      const repeated = addResult(again.stdout);
      expect(repeated.snapshot_digest).toBe(entry.snapshot_digest);
      expect(repeated.retained_version_id).toBe(entry.retained_version_id);
      expect((await gitInvocations(shim.log)).slice(beforeRepeat).map((args) => args[0])).toEqual([
        "clone",
        "checkout",
        "rev-parse",
      ]);
      const after = Schema.decodeUnknownSync(LibraryCountsDocument)(
        await readFile(join(roots.home, "state.json"), "utf8"),
      );
      expect(after.collections).toHaveLength(1);
      expect(after.retained_copies).toHaveLength(1);
      expect(after.acquisitions).toHaveLength(2);
      expect(after.acquisitions[0]?.retained_copy_id).toBe(after.acquisitions[1]?.retained_copy_id);
      expect(after.projections).toEqual([]);

      // Preview after add still agrees and still writes nothing of its own.
      const previewAgain = await run("add", REMOTE, "--list");
      expect(previewAgain.code, previewAgain.stderr).toBe(0);
      const previewedAgain = Schema.decodeUnknownSync(AddPreviewDocument)(previewAgain.stdout).data;
      expect(previewedAgain.skills).toEqual(entry.skills);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.runIf(realGit)(
  "preview and add agree for a plain-Skill Git subpath without a generated wrapper",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-git-subpath-"));
    try {
      const fixture = await repository(root, true);
      const shim = await gitShim(root, fixture.repo);
      const roots = isolatedRoots(root);
      const source = `${REMOTE}#ref=main&path=imported`;

      const run = (...args: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              bin,
              ...args,
              "--json",
              "--home",
              roots.home,
              "--codex-root",
              roots.codexRoot,
              "--claude-root",
              roots.claudeRoot,
              "--opencode-root",
              roots.opencodeRoot,
              "--devin-root",
              roots.devinRoots[0],
            ],
            {
              env: {
                ...process.env,
                PATH: `${shim.directory}:${process.env.PATH}`,
                SKIT_HOME: roots.home,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout!.on("data", (chunk) => (stdout += chunk));
          child.stderr!.on("data", (chunk) => (stderr += chunk));
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        });

      const preview = await run("add", source, "--list");
      expect(preview.code, preview.stderr).toBe(0);
      const previewed = Schema.decodeUnknownSync(AddPreviewDocument)(preview.stdout).data;
      expect(previewed.kind).toBe("plain");
      expect(existsSync(join(roots.home, "state.json"))).toBe(false);

      const added = await run("add", source);
      expect(added.code, added.stderr).toBe(0);
      const entry = addResult(added.stdout);
      expect(entry.skills).toEqual(previewed.skills);
      expect(entry.skills.map((skill) => skill.name).sort()).toEqual([
        "code-review",
        "security-review",
      ]);
      const firstState = Schema.decodeUnknownSync(LibraryCountsDocument)(
        await readFile(join(roots.home, "state.json"), "utf8"),
      );
      const hex = firstState.retained_copies[0].digest.slice("sha256:".length);
      const originalPath = join(roots.home, "originals", hex.slice(0, 2), hex);
      expect(existsSync(join(originalPath, "README.md"))).toBe(false);
      expect(existsSync(join(originalPath, "skit.json"))).toBe(false);
      expect(existsSync(join(originalPath, "outside-skill"))).toBe(false);
      expect(firstState.acquisitions[0]).toMatchObject({
        tracking: { kind: "commit", ref: fixture.head },
        selection: {
          kind: "selected-paths",
          paths: ["code-review", "security-review"],
        },
        source_revision: fixture.head,
      });

      // A new checkout of the same bytes reuses the verbatim Version without timestamp evidence.
      const again = await run("add", source);
      expect(again.code, again.stderr).toBe(0);
      const repeated = addResult(again.stdout);
      expect(repeated.snapshot_digest).toBe(entry.snapshot_digest);
      expect(repeated.retained_version_id).toBe(entry.retained_version_id);
      const state = Schema.decodeUnknownSync(LibraryCountsDocument)(
        await readFile(join(roots.home, "state.json"), "utf8"),
      );
      expect(state.collections).toHaveLength(1);
      expect(state.retained_copies).toHaveLength(1);
      expect(state.acquisitions).toHaveLength(2);
      expect(state.acquisitions[0]?.retained_copy_id).toBe(state.acquisitions[1]?.retained_copy_id);
      expect(state.projections).toEqual([]);
      expect(state.global_bindings).toEqual([]);
      expect(state.local_bindings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
