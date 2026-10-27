import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

/** A file the user owned before the trial. Its bytes must survive whatever the agent does. */
export interface UserFile {
  /** Relative to the run's home. */
  readonly path: string;
  readonly sha256: string;
}

/** A symlink the user made before the trial. It must still be a link to the same target. */
export interface UserLink {
  /** Relative to the run's home. */
  readonly path: string;
  readonly target: string;
}

export interface Fixture {
  readonly userFiles: readonly UserFile[];
  readonly userLinks: readonly UserLink[];
}

function skillDocument(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function writeUserFile(home: string, path: string, contents: string): UserFile {
  const absolute = join(home, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return { path, sha256: sha256(contents) };
}

/**
 * Case 0: a machine that has never run skit. Claude Code is present with one skill the user wrote
 * themselves. No Library, no work directory, no duplicates, no lockfiles.
 */
export function baseCaseFixture(home: string): Fixture {
  mkdirSync(join(home, ".claude"), { recursive: true });
  return {
    userFiles: [
      writeUserFile(
        home,
        ".claude/skills/release-notes/SKILL.md",
        skillDocument(
          "release-notes",
          "Draft release notes from merged pull requests when the user asks for release notes.",
          "Group merged pull requests by area. Lead with user-visible changes. Keep each entry to one line.",
        ),
      ),
    ],
    userLinks: [],
  };
}

/**
 * Case 1: a machine that has used skills for a while and never run skit. Every situation setup
 * has to decide about appears once:
 * - a skill installed for both Claude Code and the shared `.agents` root, with different content
 * - a skill installed in both places with identical content
 * - a skill symlinked into `~/.claude/skills` from a dotfiles checkout
 * - a skills.sh install with its global lockfile
 * - two repositories under `~/Work`, one committing its skill and one leaving it untracked
 */
export function messyHomeFixture(home: string): Fixture {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const userFiles: UserFile[] = [];
  const skill = (path: string, name: string, description: string, body: string) =>
    userFiles.push(writeUserFile(home, `${path}/SKILL.md`, skillDocument(name, description, body)));

  skill(
    ".claude/skills/release-notes",
    "release-notes",
    "Draft release notes from merged pull requests when the user asks for release notes.",
    "Group merged pull requests by area. Lead with user-visible changes.",
  );
  skill(
    ".claude/skills/review",
    "review",
    "Review a diff for correctness before it is merged.",
    "Check error handling first, then naming. Flag missing tests.",
  );
  skill(
    ".agents/skills/review",
    "review",
    "Review a diff for correctness and security before it is merged.",
    "Check error handling, input validation and secrets. Flag missing tests.",
  );
  for (const root of [".claude/skills/commit", ".agents/skills/commit"])
    skill(
      root,
      "commit",
      "Write a conventional commit message for the staged changes.",
      "Use a type prefix and an imperative summary under 72 characters.",
    );
  skill(
    "dotfiles/skills/standup",
    "standup",
    "Summarise yesterday's work for a standup update.",
    "Read the git log since yesterday morning and list the three most important changes.",
  );
  const standup = { path: ".claude/skills/standup", target: join(home, "dotfiles/skills/standup") };
  symlinkSync(standup.target, join(home, standup.path));

  skill(
    ".agents/skills/web-design-guidelines",
    "web-design-guidelines",
    "Review UI code against web interface guidelines.",
    "Check accessibility, focus states and layout shift.",
  );
  userFiles.push(
    writeUserFile(
      home,
      ".agents/.skill-lock.json",
      JSON.stringify(
        {
          version: 3,
          skills: {
            "web-design-guidelines": {
              source: "vercel-labs/agent-skills",
              sourceType: "github",
              ref: "main",
              skillPath: "skills/web-design-guidelines/SKILL.md",
            },
          },
        },
        null,
        2,
      ),
    ),
  );

  skill(
    "Work/app/.agents/skills/deploy",
    "deploy",
    "Deploy the app to staging when the user asks to ship.",
    "Run the test suite, then `pnpm deploy:staging`.",
  );
  commitRepository(join(home, "Work/app"));
  skill(
    "Work/site/.claude/skills/lint",
    "lint",
    "Fix lint errors in the site before committing.",
    "Run `pnpm lint --fix` and review what changed.",
  );
  writeFileSync(join(home, "Work/site/README.md"), "# site\n");
  commitRepository(join(home, "Work/site"), ["README.md"]);
  return { userFiles, userLinks: [standup] };
}

/** A repository with history, committing `paths` (everything when omitted). */
function commitRepository(path: string, paths: readonly string[] = ["."]): void {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
      {
        cwd: path,
        stdio: "ignore",
      },
    );
  git("init", "-q", "-b", "main");
  git("add", ...paths);
  git("commit", "-q", "-m", "initial");
}

export interface UserFileCheck extends UserFile {
  readonly status: "intact" | "changed" | "missing";
}

export function checkUserFiles(home: string, fixture: Fixture): readonly UserFileCheck[] {
  return fixture.userFiles.map((file) => {
    const absolute = join(home, file.path);
    if (!existsSync(absolute)) return { ...file, status: "missing" };
    return {
      ...file,
      status: sha256(readFileSync(absolute)) === file.sha256 ? "intact" : "changed",
    };
  });
}

export interface UserLinkCheck extends UserLink {
  readonly status: "intact" | "replaced" | "missing";
}

export function checkUserLinks(home: string, fixture: Fixture): readonly UserLinkCheck[] {
  return fixture.userLinks.map((link) => {
    const absolute = join(home, link.path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return { ...link, status: "missing" };
    return {
      ...link,
      status:
        stat.isSymbolicLink() && readlinkSync(absolute) === link.target ? "intact" : "replaced",
    };
  });
}

export function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function relativeToHome(home: string, path: string): string {
  return relative(home, path) || ".";
}
