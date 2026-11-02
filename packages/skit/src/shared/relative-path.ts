/**
 * Relative paths inside a tree, always separated by `/` whatever the platform: `skills/a/SKILL.md`.
 */

/** Whether every segment is a name: not empty, `.` or `..`, and holding no `\` or NUL. */
export const isCanonicalRelativePath = (path: string) =>
  path
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !part.includes("\\") &&
        !part.includes("\0"),
    );

/** The directories above a path, nearest first: `a/b/c` gives `a/b`, then `a`. */
export const parentDirectories = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, parts.length - 1 - index).join("/"));
};
