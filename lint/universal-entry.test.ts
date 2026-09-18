import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `@smolai/skit-core/universal` is the entry the Registry Worker imports, so its import graph
 * must never reach the Node platform layer. The Worker runs on workerd, where
 * `@effect/platform-node` cannot load; the whole graph is evaluated on import, so one stray
 * re-export anywhere below the entry breaks the Worker even if nothing calls it.
 */
const coreRoot = resolve(import.meta.dirname, "../packages/skit/src");
const entry = join(coreRoot, "universal.ts");
const consumerEntry = join(coreRoot, "universal-consumer.ts");
const consumerApiEntry = join(coreRoot, "universal/api/index.ts");

/** Modules and packages the universal graph must not reach. */
const forbidden = (specifier: string): boolean =>
  specifier.startsWith("@effect/platform-node") ||
  (specifier.startsWith("node:") && specifier !== "node:crypto" && specifier !== "node:path") ||
  /\/platform\/(layer|link-stat)\.ts$/.test(specifier);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Value imports and re-exports of one module, resolved to absolute paths for local specifiers. */
function dependencies(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
    if (/^import\s+type\s/.test(match[0])) continue;
    const specifier = match[1];
    out.push(
      specifier.startsWith(".")
        ? resolve(dirname(file), specifier.replace(/\.js$/, ".ts"))
        : specifier,
    );
  }
  return out;
}

/** The first path from `entry` to a forbidden specifier, or null when the graph is clean. */
function offendingPathFrom(
  rootEntry: string,
  isForbidden: (specifier: string) => boolean = forbidden,
): string[] | null {
  const graph = new Map(sourceFiles(coreRoot).map((file) => [file, dependencies(file)]));
  const visited = new Set<string>();
  const walk = (file: string, trail: string[]): string[] | null => {
    if (visited.has(file)) return null;
    visited.add(file);
    for (const dependency of graph.get(file) ?? []) {
      const next = [...trail, dependency];
      if (isForbidden(dependency)) return next;
      if (graph.has(dependency)) {
        const found = walk(dependency, next);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(rootEntry, [rootEntry]);
}

describe("@smolai/skit-core/universal", () => {
  for (const [name, rootEntry] of [
    ["universal", entry],
    ["universal/consumer", consumerEntry],
    ["universal/api", consumerApiEntry],
  ] as const)
    test(`${name} never reaches the Node platform layer`, () => {
      const path = offendingPathFrom(rootEntry);
      expect(
        path?.map((step) => (step.startsWith("/") ? relative(coreRoot, step) : step)).join(" -> "),
      ).toBeUndefined();
    });
});

const repoRoot = resolve(import.meta.dirname, "..");

function sourceImports(directory: string): Array<{ file: string; dependency: string }> {
  return sourceFiles(directory).flatMap((file) =>
    dependencies(file).map((dependency) => ({ file, dependency })),
  );
}

describe("optional capability boundaries", () => {
  test("the consumer universal surface does not reach Authoring protocol modules", () => {
    const path = offendingPathFrom(consumerEntry, (dependency) => /\/authoring\//.test(dependency));
    expect(
      path?.map((step) => (step.startsWith("/") ? relative(coreRoot, step) : step)).join(" -> "),
    ).toBeUndefined();
  });

  test("consumer source paths do not import Author workflows or modules", () => {
    const roots = [
      "packages/skit/src/artifact",
      "packages/skit/src/library",
      "packages/skit/src/projection",
      "packages/cli/src/library",
      "packages/cli/src/invocation",
      "packages/cli/src/workflows/library",
      "packages/cli/src/handlers/library",
    ].map((path) => join(repoRoot, path));
    const offending = roots
      .flatMap(sourceImports)
      .filter(({ dependency }) => /\/authoring\/|\/workflows\/author\//.test(dependency));
    expect(
      offending.map(
        ({ file, dependency }) =>
          `${relative(repoRoot, file)} -> ${relative(repoRoot, dependency)}`,
      ),
    ).toEqual([]);
  });

  test("server consumer paths do not import Draft or Publication modules", () => {
    const roots = [
      "packages/skit-server-effect/src/integrity",
      "packages/skit-server-effect/src/library",
      "packages/skit-server-effect/src/releases",
    ].map((path) => join(repoRoot, path));
    const offending = roots
      .flatMap(sourceImports)
      .filter(({ dependency }) => /\/(drafts|publication)\//.test(dependency));
    expect(
      offending.map(
        ({ file, dependency }) =>
          `${relative(repoRoot, file)} -> ${relative(repoRoot, dependency)}`,
      ),
    ).toEqual([]);
  });
});
