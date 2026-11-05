import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { coreExports, owners } from "../architecture/app.ts";
import { features } from "../architecture/layout.mjs";

/** Check required feature entries even when a directory contains no lintable source. */
export function checkFeatures(root, declaredFeatures) {
  const failures = [];
  for (const feature of declaredFeatures) {
    const directory = join(root, feature);
    const entry = `${feature}.ts`;
    if (!statSync(join(root, entry), { throwIfNoEntry: false })?.isFile())
      failures.push(`${feature}/: missing public entry ${entry}`);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      failures.push(`${feature}/: missing feature directory`);
      continue;
    }
    for (const name of ["index.ts", `${feature.split("/").at(-1)}.ts`])
      if (existsSync(join(directory, name)))
        failures.push(`${feature}/${name}: duplicate entry; use ${entry}`);
  }
  return failures;
}

/** Every conditional target is checked, so an alternate condition cannot bypass the declaration. */
function targets(value, condition = "") {
  if (typeof value === "string") return [{ condition, target: value }];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Unsupported exports target at ${condition || "entry"}`);
  return Object.entries(value).flatMap(([key, entry]) =>
    targets(entry, condition ? `${condition}.${key}` : key),
  );
}

export function checkCoreExports(root, manifest, declarations, declaredOwners) {
  const failures = [];
  const actual = manifest.exports ?? {};
  for (const [subpath, entry] of Object.entries(actual)) {
    if (subpath === ".") continue;
    const declaration = declarations[subpath];
    if (!declaration) {
      failures.push(`${subpath}: no API declaration in architecture/app.ts coreExports`);
      continue;
    }
    if (declaration.kind === "owner") {
      if (!Array.isArray(declaration.owners) || !declaration.owners.length)
        failures.push(`${subpath}: must name at least one owner`);
      else
        for (const owner of declaration.owners)
          if (!Object.hasOwn(declaredOwners, owner))
            failures.push(`${subpath}: unknown owner ${owner}`);
      if (Object.hasOwn(declaration, "purpose"))
        failures.push(`${subpath}: owner API must declare owners, not a shared purpose`);
    } else if (declaration.kind === "shared") {
      if (typeof declaration.purpose !== "string" || !declaration.purpose.trim())
        failures.push(`${subpath}: shared API must describe its purpose`);
      if (Object.hasOwn(declaration, "owners"))
        failures.push(`${subpath}: shared API must not declare state owners`);
    } else {
      failures.push(`${subpath}: API kind must be owner or shared`);
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
      failures.push(`${subpath}: declared in app.ts but absent from core exports`);
  return failures;
}

export function checkStructure(root) {
  const manifest = JSON.parse(readFileSync(join(root, "packages/skit/package.json"), "utf8"));
  return [
    ...checkFeatures(root, features),
    ...checkCoreExports(root, manifest, coreExports, owners),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = checkStructure(resolve(import.meta.dirname, ".."));
  for (const failure of failures) console.error(failure);
  process.exitCode = failures.length ? 1 : 0;
}
