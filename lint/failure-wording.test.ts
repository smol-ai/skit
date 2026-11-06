import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const coreRoot = resolve(import.meta.dirname, "../packages/skit/src");
const repoRoot = resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Owners describe what an operator can do next in the domain's words. Only an executable knows
 * which of its commands does it, so a core failure never spells one out (shared/failure.ts).
 */
describe("failure remediation wording", () => {
  test("core failures do not name CLI commands", () => {
    const offending = sourceFiles(coreRoot).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /remediation/.test(line) && /`skit\s/.test(line)
            ? [`${relative(repoRoot, file)}:${index + 1}`]
            : [],
        ),
    );
    expect(offending).toEqual([]);
  });
});
