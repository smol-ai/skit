import type { ClaudeModelSource, ClaudeLimitSource } from "./contracts.js";
import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { basename, dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { harnessProfiles, resolveSkillsDirectory } from "../catalog.js";
import type { SkillsDirectoryOverrides, SkillListingContract } from "../contracts.js";
import { parseSkillFrontmatter } from "../frontmatter.js";
import { modelContextWindow } from "../model-context-windows.js";
import type { LibraryInventory } from "../../library/library-state.js";
import type { YamlMapping } from "../../shared/json.js";
import { ListingReadFailure, type ListingBudget, type ListingEntry } from "./contracts.js";
export interface ClaudeListingOptions {
  readonly cwd: string;
  readonly home: string;
  readonly configHome: string;
  readonly overrides?: SkillsDirectoryOverrides;
}

const Settings = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  skillListingBudgetFraction: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
  ),
  skillListingMaxDescChars: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  skillOverrides: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Literals(["on", "name-only", "user-invocable-only", "off"]),
    ),
  ),
  enabledPlugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
});
const InstalledPlugins = Schema.Struct({
  plugins: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        installPath: Schema.String,
        scope: Schema.String,
        projectPath: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export interface ClaudeListingEntry {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly collectionId?: string;
}
export interface ClaudeListingSettings {
  readonly model: string | null;
  readonly modelSource: ClaudeModelSource;
  readonly limit: number | null;
  readonly limitSource: ClaudeLimitSource;
  readonly cap: number;
  readonly overrides: Readonly<Record<string, string>>;
  readonly overrideSources: number;
  readonly configuredFraction?: { readonly value: number; readonly path?: string };
}
interface ClaudeListingSnapshot {
  readonly budget: ListingBudget;
  readonly entries: readonly ClaudeListingEntry[];
  readonly settings?: ClaudeListingSettings;
}
const characters = (value: string) => Array.from(value).length;

function deduplicateClaudeEntries(
  entries: readonly ClaudeListingEntry[],
): readonly ClaudeListingEntry[] {
  const selected = new Map<string, ClaudeListingEntry>();
  for (const entry of entries) {
    const key = `${entry.name}\0${entry.description}`;
    if (!selected.has(key)) selected.set(key, entry);
  }
  return [...selected.values()];
}

export function claudeListingResult(
  cwd: string,
  entries: readonly ClaudeListingEntry[],
  settings: ClaudeListingSettings,
  skippedPaths: readonly string[],
): ListingBudget {
  entries = deduplicateClaudeEntries(entries);
  const costs: ListingEntry[] = entries.map((e) => ({
    name: e.name,
    path: e.path,
    demand: characters(`${e.name}${e.description ? `: ${e.description}` : ""}\n`),
    ...(e.collectionId === undefined ? {} : { collectionId: e.collectionId }),
  }));
  const collections = new Map<string, { collectionId: string; skills: number; demand: number }>();
  for (const e of costs)
    if (e.collectionId !== undefined) {
      const c = collections.get(e.collectionId) ?? {
        collectionId: e.collectionId,
        skills: 0,
        demand: 0,
      };
      c.skills++;
      c.demand += e.demand;
      collections.set(e.collectionId, c);
    }
  const common = {
    harness: "claude-code" as const,
    cwd,
    model: settings.model,
    unit: "characters" as const,
    demand: costs.reduce((n, e) => n + e.demand, 0),
    entries: costs,
    collections: [...collections.values()],
    provenance: {
      _tag: "ClaudeFilesystem" as const,
      modelSource: settings.modelSource,
      limitSource: settings.limitSource,
      descriptionCap: settings.cap,
      overrideSources: settings.overrideSources,
      ...(settings.configuredFraction === undefined
        ? {}
        : { configuredFraction: settings.configuredFraction }),
    },
    skippedPaths,
    diagnostics: [],
  };
  if (settings.limit === null) return { _tag: "DemandOnly", ...common };
  // Usage order is unavailable. Bound how many whole descriptions must be dropped.
  const extra = entries
    .map((e) => (e.description ? characters(`: ${e.description}`) : 0))
    .filter((n) => n > 0);
  const overflow = Math.max(0, common.demand - settings.limit);
  const dropped = (sizes: readonly number[]) => {
    let freed = 0,
      count = 0;
    for (const size of sizes) {
      if (freed >= overflow) break;
      freed += size;
      count++;
    }
    return count;
  };
  return {
    _tag: "Estimated",
    ...common,
    limit: settings.limit,
    fitted: null,
    shortened: 0,
    omitted: 0,
    fidelity: "bounded",
    descriptionsDropped: {
      min: dropped([...extra].sort((a, b) => b - a)),
      max: dropped([...extra].sort((a, b) => a - b)),
    },
  };
}

export function claudeEntry(
  name: string,
  path: string,
  frontmatter: YamlMapping,
  fallback: string,
  settings: ClaudeListingSettings,
  collectionId?: string,
  plugin = false,
): ClaudeListingEntry | undefined {
  const override = plugin ? undefined : settings.overrides[name];
  if (override === "off" || override === "user-invocable-only") return;
  if (
    override === undefined &&
    (frontmatter["disable-model-invocation"] === true ||
      frontmatter["disable-model-invocation"] === "true")
  )
    return;
  const description =
    override === "name-only"
      ? ""
      : [
          typeof frontmatter.description === "string" ? frontmatter.description : fallback,
          typeof frontmatter.when_to_use === "string" ? frontmatter.when_to_use : "",
        ]
          .filter(Boolean)
          .join(" ")
          .trim();
  return {
    name,
    path,
    description: Array.from(description).slice(0, settings.cap).join(""),
    ...(collectionId === undefined ? {} : { collectionId }),
  };
}

function resolveClaudeListingSettings(
  contract: SkillListingContract,
  settings: typeof Settings.Type,
  sources: ReadonlyMap<string, string>,
  overrideSources: number,
  model: string | null,
  modelSource: ClaudeModelSource,
  fixedLimit: number | null,
  pinnedModel: string | null,
  pinSource: string,
): ClaudeListingSettings {
  const resolvedModel = pinnedModel ?? model;
  const contextWindow = Option.getOrNull(modelContextWindow("anthropic", resolvedModel));
  const conversion = contract.contextConversion;
  const fraction = settings.skillListingBudgetFraction ?? contract.fraction;
  let limit = fixedLimit;
  if (limit === null && conversion !== undefined)
    limit = Math.max(
      1,
      Math.floor(
        (contextWindow ?? conversion.fallbackContextWindow) *
          conversion.charactersPerToken *
          fraction,
      ),
    );
  const limitSource: ClaudeLimitSource =
    fixedLimit !== null
      ? { _tag: "Environment", name: "SLASH_COMMAND_TOOL_CHAR_BUDGET", value: fixedLimit }
      : conversion === undefined
        ? { _tag: "Unavailable" }
        : {
            _tag: "ContextConversion",
            contextWindow: contextWindow ?? conversion.fallbackContextWindow,
            source: contextWindow === null ? "fallback" : "catalog",
            charactersPerToken: conversion.charactersPerToken,
            fraction,
            clientVersion: conversion.clientVersion,
          };
  return {
    model: resolvedModel,
    modelSource: pinnedModel !== null ? { _tag: "Environment", name: pinSource } : modelSource,
    limit,
    limitSource,
    cap: settings.skillListingMaxDescChars ?? contract.descriptionCap,
    overrides: settings.skillOverrides ?? {},
    overrideSources,
    ...(settings.skillListingBudgetFraction === undefined
      ? {}
      : {
          configuredFraction: {
            value: settings.skillListingBudgetFraction,
            ...(sources.get("skillListingBudgetFraction") === undefined
              ? {}
              : { path: sources.get("skillListingBudgetFraction") }),
          },
        }),
  };
}

export const readClaudeListingSnapshot = Effect.fn("Listing.claudeDiscovery")(function* (
  state: LibraryInventory,
  options: ClaudeListingOptions,
) {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = <S extends Schema.Top>(path: string, schema: S) =>
      fs.readFileString(path).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
        Effect.mapError(
          (error) =>
            new ListingReadFailure({ reason: { _tag: "ReadFailed", path, failure: error } }),
        ),
      );
    const configuredHome = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"));
    const configDir = Option.getOrElse(configuredHome, () => join(options.home, ".claude"));
    let projectRoot = resolve(options.cwd);
    for (let current = projectRoot; ; current = dirname(current)) {
      if (yield* fs.exists(join(current, ".git"))) {
        projectRoot = current;
        break;
      }
      if (current === dirname(current)) break;
    }
    const files = [
      ...new Set([
        join(configDir, "settings.json"),
        join(projectRoot, ".claude", "settings.json"),
        join(options.cwd, ".claude", "settings.json"),
        join(options.cwd, ".claude", "settings.local.json"),
        join(projectRoot, ".claude", "settings.local.json"),
        ...(platform() === "darwin"
          ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
          : platform() === "linux"
            ? ["/etc/claude-code/managed-settings.json"]
            : []),
      ]),
    ];
    let settings: typeof Settings.Type = {};
    let overrideSources = 0;
    const sources = new Map<string, string>();
    for (const file of files) {
      if (!(yield* fs.exists(file))) continue;
      const value = yield* read(file, Settings);
      if (value.skillOverrides !== undefined) overrideSources++;
      for (const key of Object.keys(value)) sources.set(key, file);
      settings = {
        ...settings,
        ...value,
        skillOverrides: { ...settings.skillOverrides, ...value.skillOverrides },
        enabledPlugins: { ...settings.enabledPlugins, ...value.enabledPlugins },
      };
    }
    const environment = yield* Effect.all({
      model: Config.option(Config.String("ANTHROPIC_MODEL")),
      limit: Config.option(
        Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "SLASH_COMMAND_TOOL_CHAR_BUDGET"),
      ),
    });
    const model = Option.getOrNull(environment.model) ?? settings.model ?? null;
    const alias = model?.replace(/\[1m\]$/, "");
    const pinSource = `ANTHROPIC_DEFAULT_${alias?.toUpperCase()}_MODEL`;
    const pinnedModel =
      alias !== undefined && ["opus", "sonnet", "haiku", "fable"].includes(alias)
        ? Option.getOrNull(yield* Config.option(Config.String(pinSource)))
        : null;
    const resolved = resolveClaudeListingSettings(
      harnessProfiles["claude-code"].skillListing,
      settings,
      sources,
      overrideSources,
      model,
      Option.isSome(environment.model)
        ? { _tag: "Environment", name: "ANTHROPIC_MODEL" }
        : sources.has("model")
          ? { _tag: "SettingsFile", path: sources.get("model")! }
          : { _tag: "Unconfigured" },
      Option.getOrNull(environment.limit),
      pinnedModel,
      pinSource,
    );
    const skippedPaths: string[] = [];
    const roots: { root: string; namespace?: string }[] = [
      { root: resolve(options.overrides?.["claude-code"]?.[0] ?? join(configDir, "skills")) },
    ];
    for (let current = resolve(options.cwd); current !== options.home; current = dirname(current)) {
      roots.push(
        ...Object.values(harnessProfiles["claude-code"].roots)
          .filter((root) => root.scope === "project")
          .filter((root) => root.readable)
          .map((root) => ({
            root: resolveSkillsDirectory({ ...root, repository: current }),
          })),
      );
      if (current === dirname(current)) break;
    }
    const pluginFile = join(configDir, "plugins", "installed_plugins.json");
    if (yield* fs.exists(pluginFile)) {
      const plugins = yield* read(pluginFile, InstalledPlugins);
      for (const [id, installs] of Object.entries(plugins.plugins)) {
        if (settings.enabledPlugins?.[id] !== true) continue;
        for (const install of installs) {
          if (
            install.scope !== "user" &&
            install.projectPath !== projectRoot &&
            install.projectPath !== options.cwd
          )
            continue;
          roots.push({ root: join(install.installPath, "skills"), namespace: id.split("@")[0] });
        }
      }
    }
    const managed = new Map<string, string>();
    for (const installedSkill of state.installed_skills) {
      const path = yield* fs
        .realPath(join(installedSkill.path, "SKILL.md"))
        .pipe(
          Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound"
              ? Effect.succeed(resolve(installedSkill.path, "SKILL.md"))
              : Effect.fail(e),
          ),
        );
      const skill = state.skills.find((s) => s.skill_id === installedSkill.skill_id);
      if (skill) managed.set(path, skill.collection_id);
    }
    const entries = new Map<string, ClaudeListingEntry>();
    const seen = new Set<string>();
    let count = 0;
    const walk = (
      directory: string,
      namespace?: string,
    ): Effect.Effect<void, ListingReadFailure, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const canonical = yield* fs.realPath(directory).pipe(
          Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(e),
          ),
          Effect.mapError(
            (e) =>
              new ListingReadFailure({
                reason: { _tag: "ReadFailed", path: directory, failure: e },
              }),
          ),
        );
        if (canonical === null) return;
        const key = `${namespace ?? ""}\0${canonical}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (++count > 10000)
          return yield* new ListingReadFailure({
            reason: {
              _tag: "DirectoryLimitExceeded",
              path: directory,
              limit: 10_000,
              actual: count,
            },
          });
        const document = join(canonical, "SKILL.md");
        if (yield* fs.exists(document)) {
          const text = yield* fs.readFileString(document);
          const parsed = parseSkillFrontmatter(text);
          const fields = parsed ?? (text.startsWith("---") ? null : {});
          if (fields == null)
            return yield* new ListingReadFailure({
              reason: { _tag: "InvalidFrontmatter", path: document },
            });
          const shortName = typeof fields.name === "string" ? fields.name : basename(directory);
          const name = namespace === undefined ? shortName : `${namespace}:${shortName}`;
          const fallback = text.replace(/^---[\s\S]*?---\s*/, "").split(/\n\s*\n/)[0] ?? "";
          const entry = claudeEntry(
            name,
            document,
            fields,
            fallback,
            resolved,
            managed.get(document),
            namespace !== undefined,
          );
          if (entry) entries.set(`${namespace ?? ""}\0${document}`, entry);
          return;
        }
        const children = yield* fs.readDirectory(canonical);
        for (const name of children) {
          if (name.startsWith(".")) continue;
          const child = join(canonical, name);
          const info = yield* fs.stat(child).pipe(
            Effect.catchTag("PlatformError", (error) => {
              if (error.reason._tag !== "NotFound") return Effect.fail(error);
              skippedPaths.push(child);
              return Effect.succeed(null);
            }),
          );
          if (info?.type === "Directory") yield* walk(child, namespace);
        }
      }).pipe(
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(
            new ListingReadFailure({ reason: { _tag: "ReadFailed", path: directory, failure: e } }),
          ),
        ),
      );
    for (const root of roots) yield* walk(root.root, root.namespace);
    const visible = deduplicateClaudeEntries([...entries.values()]);
    return {
      entries: visible,
      settings: resolved,
      budget: claudeListingResult(options.cwd, visible, resolved, skippedPaths),
    } satisfies ClaudeListingSnapshot;
  }).pipe(
    Effect.catchTag(["PlatformError", "ConfigError", "ListingReadFailure"], (e) =>
      Effect.succeed({
        entries: [],
        budget: {
          _tag: "Unavailable" as const,
          harness: "claude-code" as const,
          cwd: options.cwd,
          reason:
            e._tag === "ListingReadFailure"
              ? { _tag: "ListingReadFailed" as const, failure: e }
              : { _tag: "NativeReadFailed" as const, failure: e },
        },
      }),
    ),
  );
});
