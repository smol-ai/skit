import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { coreExports } from "../architecture/exports.mjs";

/** Every conditional target is checked, so an alternate condition cannot bypass the declaration. */
function targets(value, condition = "") {
  if (typeof value === "string") return [{ condition, target: value }];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Unsupported exports target at ${condition || "entry"}`);
  return Object.entries(value).flatMap(([key, entry]) =>
    targets(entry, condition ? `${condition}.${key}` : key),
  );
}

export function checkCoreExports(root, manifest, declarations) {
  const failures = [];
  const actual = manifest.exports ?? {};
  for (const field of ["main", "types"])
    if (Object.hasOwn(manifest, field))
      failures.push(
        `core package.json: ${field} fallback is forbidden; use declared subpath exports`,
      );
  if (existsSync(join(root, "packages/skit/src/index.ts")))
    failures.push("packages/skit/src/index.ts: core root entry is forbidden");
  for (const [subpath, entry] of Object.entries(actual)) {
    if (subpath === ".") {
      failures.push(".: core root export is forbidden; use declared subpaths");
      continue;
    }
    const declaration = declarations[subpath];
    if (!declaration) {
      failures.push(`${subpath}: no API declaration in architecture/exports.mjs coreExports`);
      continue;
    }
    const source = declaration.source;
    if (
      !source.startsWith("packages/skit/src/") ||
      source.includes("/../") ||
      !source.endsWith(".ts")
    ) {
      failures.push(`${subpath}: source must be a core TypeScript module, got ${source}`);
      continue;
    }
    if (!statSync(join(root, source), { throwIfNoEntry: false })?.isFile())
      failures.push(`${subpath}: missing source ${source}`);
    const output = source.replace(/^packages\/skit\/src\//, "./dist/").replace(/\.ts$/, "");
    const entries = targets(entry);
    if (!entries.length) failures.push(`${subpath}: exports target is empty`);
    for (const { condition, target } of entries) {
      const expected = `${output}${condition.split(".").includes("types") ? ".d.ts" : ".js"}`;
      if (target !== expected)
        failures.push(
          `${subpath}${condition ? ` (${condition})` : ""}: expected ${expected}, got ${target}`,
        );
    }
  }
  for (const subpath of Object.keys(declarations))
    if (!Object.hasOwn(actual, subpath))
      failures.push(`${subpath}: declared in exports.mjs but absent from core exports`);
  return failures;
}

export function checkStructure(root) {
  const manifest = JSON.parse(readFileSync(join(root, "packages/skit/package.json"), "utf8"));
  return checkCoreExports(root, manifest, coreExports);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = checkStructure(resolve(import.meta.dirname, ".."));
  for (const failure of failures) console.error(failure);
  process.exitCode = failures.length ? 1 : 0;
}
