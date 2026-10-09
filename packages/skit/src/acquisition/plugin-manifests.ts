import { Data, Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LinkStat } from "../platform/link-stat.js";
import { isJsonObject, type JsonObject } from "../shared/json.js";
import type { SourceDiscoveryDiagnostic } from "./source-diagnostics.js";

export class PluginManifestInvalid extends Data.TaggedError("PluginManifestInvalid")<{
  path: string;
  detail: string;
  reason?: "escape";
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message() {
    return `Invalid plugin declaration at ${this.path}: ${this.detail}`;
  }
}

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
export const containedPluginPathEffect = Effect.fn("Source.containedPluginPath")(function* (
  sourceRoot: string,
  base: string,
  path: string,
) {
  if (!path || isAbsolute(path))
    return yield* new PluginManifestInvalid({
      path: base,
      detail: `Invalid relative path ${path}`,
      reason: "escape",
    });
  const selected = resolve(base, path);
  if (!within(sourceRoot, selected))
    return yield* new PluginManifestInvalid({
      path: selected,
      detail: "Path escapes the Source",
      reason: "escape",
    });
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(selected)))
    return yield* new PluginManifestInvalid({ path: selected, detail: "Declared path is missing" });
  const real = yield* fs.realPath(selected);
  if (!within(yield* fs.realPath(sourceRoot), real))
    return yield* new PluginManifestInvalid({
      path: selected,
      detail: "Link escapes the Source",
      reason: "escape",
    });
  return selected;
});

const readManifestEffect = Effect.fn("Source.readPluginManifest")(function* (
  sourceRoot: string,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const selected = yield* containedPluginPathEffect(sourceRoot, dirname(path), basename(path));
  const info = yield* fs.stat(selected);
  if (info.type !== "File" || Number(info.size) > 1_048_576)
    return yield* new PluginManifestInvalid({
      path,
      detail: "Expected a JSON file no larger than 1 MiB",
    });
  return yield* Schema.decodeUnknownEffect(jsonObject)(yield* fs.readFileString(selected)).pipe(
    Effect.mapError(() => new PluginManifestInvalid({ path, detail: "Expected a JSON object" })),
  );
});

function skillPaths(value: unknown, path: string) {
  if (value === undefined) return Effect.succeed([] as string[]);
  if (typeof value === "string") return Effect.succeed([value]);
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string"))
    return Effect.succeed(value);
  return Effect.fail(
    new PluginManifestInvalid({ path, detail: "skills must be a path or array of paths" }),
  );
}

const scanSkillDirectoryEffect = Effect.fn("Source.scanPluginSkills")(function* (
  sourceRoot: string,
  root: string,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const probe = yield* LinkStat;
  if (isAbsolute(path) || !within(root, resolve(root, path)))
    return yield* new PluginManifestInvalid({
      path: root,
      detail: "Skill path escapes the plugin root",
      reason: "escape",
    });
  const selected = yield* containedPluginPathEffect(sourceRoot, root, path);
  if ((yield* fs.stat(selected)).type !== "Directory")
    return yield* new PluginManifestInvalid({
      path: selected,
      detail: "Expected a Skill directory",
    });
  if (yield* fs.exists(join(selected, "SKILL.md"))) {
    yield* containedPluginPathEffect(sourceRoot, selected, "SKILL.md");
    return [selected];
  }
  const skills: string[] = [];
  for (const name of (yield* fs.readDirectory(selected)).sort()) {
    const child = join(selected, name);
    const info = yield* probe.identity.lstat(child);
    if (info.type !== "Directory" && info.type !== "SymbolicLink") continue;
    if (!(yield* fs.exists(join(child, "SKILL.md")))) continue;
    yield* containedPluginPathEffect(sourceRoot, selected, name);
    yield* containedPluginPathEffect(sourceRoot, child, "SKILL.md");
    skills.push(child);
  }
  return skills;
});

/** Decode declarations separately from SKIT's choice of Collection members. */
export const readPluginUnitsEffect = Effect.fn("Source.readPluginUnits")(function* (
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
        if (error.reason === "escape" || (options.strictRoot && explicit))
          return Effect.fail(error);
        const diagnostic: SourceDiscoveryDiagnostic = {
          code: "plugin-manifest-invalid",
          path: relative(sourceRoot, error.path) || ".",
          message: error.detail,
        };
        if (
          !options.diagnostics?.some(
            (item) => item.path === diagnostic.path && item.message === diagnostic.message,
          )
        )
          options.diagnostics?.push(diagnostic);
        return Effect.succeed(undefined);
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
      const portable = yield* readManifestEffect(containmentRoot, join(root, "plugin.json"));
      if (portable.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
        manifestPath = join(root, "plugin.json");
        manifest = portable;
        registered.add(`portable:${root}`);
      }
    }
    if (manifest === undefined && (yield* fs.exists(manifestPath)))
      manifest = yield* readManifestEffect(containmentRoot, manifestPath);
    if (
      provider === "portable" &&
      manifest?.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    )
      return;
    if (!manifest && !entry) return;
    if (entry?.strict !== undefined && typeof entry.strict !== "boolean")
      return yield* new PluginManifestInvalid({
        path: manifestPath,
        detail: "strict must be boolean",
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
        detail: "Marketplace entry conflicts with plugin manifest under strict:false",
      });
    const name = manifest?.name ?? entry?.name ?? basename(root);
    if (typeof name !== "string" || !name.trim())
      return yield* new PluginManifestInvalid({
        path: manifestPath,
        detail: "Expected a nonempty plugin name",
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
      for (const member of yield* scanSkillDirectoryEffect(containmentRoot, root, path))
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
          const marketplace = yield* readManifestEffect(containmentRoot, path);
          if (!Array.isArray(marketplace.plugins))
            return yield* new PluginManifestInvalid({ path, detail: "plugins must be an array" });
          if (marketplace.plugins.length > 5_000)
            return yield* new PluginManifestInvalid({
              path,
              detail: "Marketplace exceeds 5,000 entries",
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
                detail: "Expected a plugin entry object",
              });
            const source = entry.source;
            let local: string | undefined;
            if (typeof source === "string" && !/^(?:https?:|git@|ssh:)/.test(source)) {
              local = source;
              if (provider === "claude" && !source.startsWith(".") && pluginRoot !== undefined) {
                if (typeof pluginRoot !== "string")
                  return yield* new PluginManifestInvalid({
                    path,
                    detail: "metadata.pluginRoot must be a path",
                  });
                local = join(pluginRoot, source);
              }
            } else if (isJsonObject(source) && source.source === "local") {
              if (typeof source.path !== "string")
                return yield* new PluginManifestInvalid({
                  path,
                  detail: "Local source requires a path",
                });
              local = source.path;
            } else if (source === undefined) {
              return yield* new PluginManifestInvalid({
                path,
                detail: "Plugin entry requires a source",
              });
            }
            // Remote plugin dependencies are not part of this acquired Source.
            if (local === undefined) return;
            const root = yield* containedPluginPathEffect(containmentRoot, directory, local);
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
