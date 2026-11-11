import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LinkStat } from "../platform/link-stat.js";
import { isJsonObject, type JsonObject } from "../shared/json.js";
import type { SourceDiscoveryDiagnostic } from "./source-diagnostics.js";
import { PluginManifestInvalid, PluginManifestInvalidReason } from "./plugin-failures.js";
export { PluginManifestInvalid } from "./plugin-failures.js";
import { isDeepStrictEqual } from "node:util";

export interface PluginUnit {
  readonly name: string;
  readonly provider: "claude" | "codex" | "portable";
  readonly root: string;
  readonly skills: readonly string[];
}

const jsonObject = Schema.fromJsonString(Schema.JsonObject);
const within = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

/** All declaration reads and selected directories stay within the acquired Source. */
export const containedPluginPath = Effect.fn("Source.containedPluginPath")(function* (
  sourceRoot: string,
  base: string,
  path: string,
) {
  if (!path || isAbsolute(path))
    return yield* new PluginManifestInvalid({
      path: base,
      reason: { _tag: "RelativePathInvalid", requested: path },
    });
  const selected = resolve(base, path);
  if (!within(sourceRoot, selected))
    return yield* new PluginManifestInvalid({
      path: selected,
      reason: { _tag: "SourceEscape", root: sourceRoot, selected },
    });
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(selected)))
    return yield* new PluginManifestInvalid({
      path: selected,
      reason: { _tag: "DeclaredPathMissing" },
    });
  const real = yield* fs.realPath(selected);
  const realRoot = yield* fs.realPath(sourceRoot);
  if (!within(realRoot, real))
    return yield* new PluginManifestInvalid({
      path: selected,
      reason: { _tag: "LinkEscape", root: realRoot, target: real },
    });
  return selected;
});

const readManifest = Effect.fn("Source.readPluginManifest")(function* (
  sourceRoot: string,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const selected = yield* containedPluginPath(sourceRoot, dirname(path), basename(path));
  const info = yield* fs.stat(selected);
  if (info.type !== "File")
    return yield* new PluginManifestInvalid({
      path,
      reason: { _tag: "ManifestNotFile", kind: info.type },
    });
  if (Number(info.size) > 1_048_576)
    return yield* new PluginManifestInvalid({
      path,
      reason: { _tag: "ManifestTooLarge", actual: Number(info.size), limit: 1_048_576 },
    });
  return yield* Schema.decodeEffect(jsonObject)(yield* fs.readFileString(selected)).pipe(
    Effect.mapError(
      (failure) => new PluginManifestInvalid({ path, reason: { _tag: "InvalidJson", failure } }),
    ),
  );
});

function skillPaths(value: Schema.Json | undefined, path: string) {
  if (value === undefined) return Effect.succeed([] as string[]);
  if (typeof value === "string") return Effect.succeed([value]);
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string"))
    return Effect.succeed(value);
  return Effect.fail(
    new PluginManifestInvalid({ path, reason: { _tag: "SkillPathsInvalid", value } }),
  );
}

const scanSkillDirectory = Effect.fn("Source.scanPluginSkills")(function* (
  sourceRoot: string,
  root: string,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const probe = yield* LinkStat;
  if (isAbsolute(path) || !within(root, resolve(root, path)))
    return yield* new PluginManifestInvalid({
      path: root,
      reason: { _tag: "SkillPathEscape", root, requested: path },
    });
  const selected = yield* containedPluginPath(sourceRoot, root, path);
  const info = yield* fs.stat(selected);
  if (info.type !== "Directory")
    return yield* new PluginManifestInvalid({
      path: selected,
      reason: { _tag: "SkillDirectoryRequired", kind: info.type },
    });
  if (yield* fs.exists(join(selected, "SKILL.md"))) {
    yield* containedPluginPath(sourceRoot, selected, "SKILL.md");
    return [selected];
  }
  const skills: string[] = [];
  for (const name of (yield* fs.readDirectory(selected)).sort()) {
    const child = join(selected, name);
    const info = yield* probe.identity.lstat(child);
    if (info.type !== "Directory" && info.type !== "SymbolicLink") continue;
    if (!(yield* fs.exists(join(child, "SKILL.md")))) continue;
    yield* containedPluginPath(sourceRoot, selected, name);
    yield* containedPluginPath(sourceRoot, child, "SKILL.md");
    skills.push(child);
  }
  return skills;
});

/** Decode declarations separately from SKIT's choice of Collection members. */
export const readPluginUnits = Effect.fn("Source.readPluginUnits")(function* (
  sourceRoot: string,
  directories: readonly string[],
  containmentRoot = sourceRoot,
  options: { diagnostics?: SourceDiscoveryDiagnostic[]; strictRoot?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const units: PluginUnit[] = [];
  const registered = new Set<string>();
  const attempt = <A, R>(
    operation: Effect.Effect<A, PlatformError | PluginManifestInvalid, R>,
    explicit: boolean,
  ) =>
    operation.pipe(
      Effect.catchTag("PluginManifestInvalid", (error) => {
        if (
          PluginManifestInvalidReason.isAnyOf([
            "RelativePathInvalid",
            "SourceEscape",
            "LinkEscape",
            "SkillPathEscape",
          ])(error.reason) ||
          (options.strictRoot && explicit)
        )
          return Effect.fail(error);
        const diagnostic: SourceDiscoveryDiagnostic = {
          code: "plugin-manifest-invalid",
          path: relative(sourceRoot, error.path) || ".",
          reason: error.reason,
        };
        if (
          !options.diagnostics?.some(
            (item) =>
              item.code === diagnostic.code &&
              item.path === diagnostic.path &&
              isDeepStrictEqual(item.reason, diagnostic.reason),
          )
        )
          options.diagnostics?.push(diagnostic);
        return Effect.undefined;
      }),
    );
  const addUnit = Effect.fn("Source.pluginUnit")(function* (
    root: string,
    provider: PluginUnit["provider"],
    entry?: JsonObject,
    marketplaceRoot?: string,
  ) {
    let manifestPath = join(
      root,
      provider === "claude"
        ? ".claude-plugin/plugin.json"
        : provider === "codex"
          ? ".codex-plugin/plugin.json"
          : "plugin.json",
    );
    let manifest: Schema.Schema.Type<typeof Schema.JsonObject> | undefined;
    // Portable package identity and components are canonical; the Codex overlay
    // supplies settings, not an additional set of Skill directories.
    if (provider === "codex" && (yield* fs.exists(join(root, "plugin.json")))) {
      const portable = yield* readManifest(containmentRoot, join(root, "plugin.json"));
      if (portable.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
        manifestPath = join(root, "plugin.json");
        manifest = portable;
        registered.add(`portable:${root}`);
      }
    }
    if (manifest === undefined && (yield* fs.exists(manifestPath)))
      manifest = yield* readManifest(containmentRoot, manifestPath);
    if (
      provider === "portable" &&
      manifest?.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    )
      return;
    if (!manifest && !entry) return;
    if (entry?.strict !== undefined && typeof entry.strict !== "boolean")
      return yield* new PluginManifestInvalid({
        path: manifestPath,
        reason: { _tag: "StrictInvalid", value: entry.strict },
      });
    if (
      manifest &&
      entry?.strict === false &&
      ["skills", "commands", "agents", "hooks", "outputStyles", "themes"].some(
        (key) => entry[key] !== undefined,
      )
    )
      return yield* new PluginManifestInvalid({
        path: manifestPath,
        reason: {
          _tag: "MarketplaceComponentsConflict",
          fields: ["skills", "commands", "agents", "hooks", "outputStyles", "themes"].filter(
            (key) => entry[key] !== undefined,
          ),
        },
      });
    const name = manifest?.name ?? entry?.name ?? basename(root);
    if (typeof name !== "string" || !name.trim())
      return yield* new PluginManifestInvalid({
        path: manifestPath,
        reason: { _tag: "NameInvalid", value: name },
      });
    const extra = yield* skillPaths(manifest?.skills, manifestPath);
    const selected = yield* skillPaths(entry?.skills, manifestPath);
    // A root marketplace entry with explicit members is a virtual plugin selection.
    const entryOnly = entry !== undefined && root === marketplaceRoot && entry.skills !== undefined;
    const paths = entryOnly ? selected : [...extra, ...selected];
    if (!entryOnly && (yield* fs.exists(join(root, "skills")))) paths.unshift("./skills");
    if (
      !paths.length &&
      manifest?.skills === undefined &&
      entry?.skills === undefined &&
      (yield* fs.exists(join(root, "SKILL.md")))
    )
      paths.push(".");
    const members = new Set<string>();
    for (const path of new Set(paths))
      for (const member of yield* scanSkillDirectory(containmentRoot, root, path))
        members.add(member);
    units.push({ name, provider, root, skills: [...members].sort() });
    registered.add(`${provider}:${root}`);
  });

  for (const directory of directories) {
    for (const provider of ["claude", "codex"] as const) {
      const path = join(
        directory,
        provider === "claude"
          ? ".claude-plugin/marketplace.json"
          : ".agents/plugins/marketplace.json",
      );
      if (!(yield* fs.exists(path))) continue;
      const marketplace = yield* attempt(
        Effect.gen(function* () {
          const marketplace = yield* readManifest(containmentRoot, path);
          if (!Array.isArray(marketplace.plugins))
            return yield* new PluginManifestInvalid({
              path,
              reason: {
                _tag: "PluginsArrayRequired",
                ...(marketplace.plugins === undefined ? {} : { value: marketplace.plugins }),
              },
            });
          if (marketplace.plugins.length > 5_000)
            return yield* new PluginManifestInvalid({
              path,
              reason: {
                _tag: "MarketplaceTooLarge",
                actual: marketplace.plugins.length,
                limit: 5_000,
              },
            });
          return { plugins: marketplace.plugins, metadata: marketplace.metadata };
        }),
        directory === sourceRoot,
      );
      if (marketplace === undefined) continue;
      const pluginRoot = isJsonObject(marketplace.metadata)
        ? marketplace.metadata.pluginRoot
        : undefined;
      for (const entry of marketplace.plugins) {
        yield* attempt(
          Effect.gen(function* () {
            if (!isJsonObject(entry))
              return yield* new PluginManifestInvalid({
                path,
                reason: { _tag: "PluginEntryInvalid", value: entry },
              });
            const source = entry.source;
            let local: string | undefined;
            if (typeof source === "string" && !/^(?:https?:|git@|ssh:)/.test(source)) {
              local = source;
              if (provider === "claude" && !source.startsWith(".") && pluginRoot !== undefined) {
                if (typeof pluginRoot !== "string")
                  return yield* new PluginManifestInvalid({
                    path,
                    reason: { _tag: "PluginRootInvalid", value: pluginRoot },
                  });
                local = join(pluginRoot, source);
              }
            } else if (isJsonObject(source) && source.source === "local") {
              if (typeof source.path !== "string")
                return yield* new PluginManifestInvalid({
                  path,
                  reason: {
                    _tag: "LocalPathInvalid",
                    ...(source.path === undefined ? {} : { value: source.path }),
                  },
                });
              local = source.path;
            } else if (source === undefined) {
              return yield* new PluginManifestInvalid({
                path,
                reason: { _tag: "PluginSourceMissing" },
              });
            }
            // Remote plugin dependencies are not part of this acquired Source.
            if (local === undefined) return;
            const root = yield* containedPluginPath(containmentRoot, directory, local);
            yield* addUnit(root, provider, entry, directory);
          }),
          directory === sourceRoot,
        );
      }
    }
  }
  for (const directory of directories) {
    // A metadata directory's plugin.json belongs to its parent, not a nested package.
    if ([".claude-plugin", ".codex-plugin", ".cursor-plugin"].includes(basename(directory)))
      continue;
    for (const provider of ["claude", "codex", "portable"] as const) {
      if (!registered.has(`${provider}:${directory}`))
        yield* attempt(addUnit(directory, provider), directory === sourceRoot);
    }
  }
  return units;
});
