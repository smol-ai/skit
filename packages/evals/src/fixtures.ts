import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** A file the user owned before the trial. Its bytes must survive whatever the agent does. */
export interface UserFile {
  /** Relative to the run's home. */
  readonly path: string;
  readonly sha256: string;
}

export interface Fixture {
  readonly userFiles: readonly UserFile[];
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
  };
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

export function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function relativeToHome(home: string, path: string): string {
  return relative(home, path) || ".";
}
