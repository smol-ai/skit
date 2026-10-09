import { Data, Effect, FileSystem } from "effect";
import { basename, join, relative, resolve, sep } from "node:path";
import { deterministicTreeHashEffect } from "../artifact/skit.js";
import { parseSkillFrontmatter } from "../harnesses/frontmatter.js";
import {
  containedPluginPathEffect,
  readPluginUnitsEffect,
  type PluginUnit,
} from "./plugin-manifests.js";
import type { SourceDiscoveryDiagnostic } from "./source-diagnostics.js";

export class PluginSkillConflict extends Data.TaggedError("PluginSkillConflict")<{
  name: string;
  paths: readonly string[];
  directories: readonly string[];
  locators?: readonly string[];
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message() {
    const selections = this.locators
      ? this.locators.map((locator) => `  skit add '${locator.replaceAll("'", "'\\''")}'`)
      : this.directories.map((directory) => `  ${directory}`);
    return `Skill name ${JSON.stringify(this.name)} is ambiguous at ${this.paths.map((path) => JSON.stringify(path)).join(" and ")}. Select the plugin or Skill directory explicitly; different plugin Skills cannot share one Collection name.\nAvailable selections:\n${selections.join("\n")}`;
  }
}

/** Manifest facts determine ownership; existing paths determine refresh compatibility. */
export const selectPluginMembersEffect = Effect.fn("Source.selectPluginMembers")(function* (
  root: string,
  directories: readonly string[],
  foundSkills: readonly string[],
  previousSkillPaths: readonly string[],
  containmentRoot: string,
  strictRoot = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const diagnostics: SourceDiscoveryDiagnostic[] = [];
  const units = yield* readPluginUnitsEffect(root, directories, containmentRoot, {
    diagnostics,
    strictRoot,
  });
  const ownership = new Map<string, PluginUnit[]>();
  for (const unit of units)
    for (const path of unit.skills) {
      const owners = ownership.get(path) ?? [];
      owners.push(unit);
      ownership.set(path, owners);
    }
  const owners = (path: string) => ownership.get(path) ?? [];
  const standalone = foundSkills.filter(
    (path) =>
      !units.some(
        (unit) =>
          unit.root !== root &&
          unit.skills.length > 0 &&
          (path === unit.root || path.startsWith(`${unit.root}${sep}`)),
      ),
  );
  const candidates = [...new Set([...standalone, ...units.flatMap((unit) => unit.skills)])];
  // Existing membership is additive, never an exclusive lock that hides newly added Skills.
  for (const path of previousSkillPaths) {
    if (!(yield* fs.exists(join(root, path, "SKILL.md")))) continue;
    const directory = yield* containedPluginPathEffect(containmentRoot, root, path);
    yield* containedPluginPathEffect(containmentRoot, directory, "SKILL.md");
    if (!candidates.includes(directory)) candidates.push(directory);
  }
  const previous = new Set(previousSkillPaths.map((path) => resolve(root, path)));
  candidates.sort(
    (a, b) =>
      Number(previous.has(b)) - Number(previous.has(a)) ||
      owners(a).length - owners(b).length ||
      relative(root, a).split(sep).length - relative(root, b).split(sep).length ||
      a.localeCompare(b),
  );
  const selected: { path: string; name: string }[] = [];
  const byName = new Map<string, { path: string; name: string }>();
  const digests = new Map<string, string>();
  const digest = Effect.fn("Source.pluginMirrorDigest")(function* (path: string) {
    let value = digests.get(path);
    if (value === undefined) {
      value = yield* deterministicTreeHashEffect(yield* fs.realPath(path));
      digests.set(path, value);
    }
    return value;
  });
  const facts = yield* Effect.forEach(candidates, (path) =>
    Effect.gen(function* () {
      const metadata = parseSkillFrontmatter(yield* fs.readFileString(join(path, "SKILL.md")));
      const name =
        typeof metadata?.name === "string" && metadata.name.trim()
          ? metadata.name.trim()
          : basename(path);
      return { path, name };
    }),
  );
  for (const { path, name } of facts) {
    const duplicate = byName.get(name);
    if (duplicate === undefined) {
      selected.push({ path, name });
      byName.set(name, { path, name });
      continue;
    }
    const left = owners(duplicate.path);
    const right = owners(path);
    const sameUnit = left.some((a) =>
      right.some(
        (b) => a.name === b.name && (a.root === b.root || a.root === root || b.root === root),
      ),
    );
    const mirror =
      (left.length === 0 && right.length > 0) ||
      (left.length > 0 && right.length === 0) ||
      sameUnit;
    if (mirror && (yield* digest(duplicate.path)) === (yield* digest(path))) continue;
    if (previous.has(duplicate.path) && !previous.has(path)) {
      diagnostics.push({
        code: "plugin-member-held",
        path: relative(root, path),
        message: `Kept existing Skill ${JSON.stringify(name)} at ${relative(root, duplicate.path)}; this conflicting candidate was left unselected.`,
      });
      continue;
    }
    if (left.length || right.length) {
      const conflicts = facts.filter((skill) => skill.name === name);
      return yield* new PluginSkillConflict({
        name,
        paths: conflicts.map((skill) => relative(root, skill.path)),
        directories: [
          ...new Set(
            conflicts.flatMap((skill) => {
              const units = owners(skill.path);
              return units.length
                ? units.map((unit) => relative(root, unit.root === root ? skill.path : unit.root))
                : [relative(root, skill.path)];
            }),
          ),
        ],
      });
    }
    // Ordinary standalone duplicate validation remains at the existing import boundary.
    selected.push({ path, name });
  }
  return { members: selected.map((skill) => skill.path), diagnostics };
});
