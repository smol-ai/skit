import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { basename, dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { harnessProfile, resolveHarnessRoot } from "../catalog.js";
import { parseSkillFrontmatter } from "../frontmatter.js";
import { modelContextWindow } from "../../models/model-context-windows.js";
import type { LibraryState } from "../../library/library-state.js";
import type { YamlMapping } from "../../shared/json.js";
import { ListingReadFailure, type ListingBudget, type ListingEntry } from "./contracts.js";
export interface ClaudeListingOptions {
  readonly cwd: string;
  readonly home: string;
  readonly configHome: string;
  readonly overrides: { readonly claude?: string };
}

const Settings = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  skillListingBudgetFraction: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
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
  readonly modelSource: string;
  readonly limit: number | null;
  readonly limitSource: string;
  readonly cap: number;
  readonly overrides: Readonly<Record<string, string>>;
  readonly notes: readonly string[];
}
export interface ClaudeListingSnapshot {
  readonly budget: ListingBudget;
  readonly entries: readonly ClaudeListingEntry[];
  readonly settings?: ClaudeListingSettings;
}
const characters = (value: string) => Array.from(value).length;

export function deduplicateClaudeEntries(
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
  coverage: readonly string[],
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
    basis: `${settings.model ?? "Model unspecified"} (${settings.modelSource}) · ${settings.limitSource}`,
    coverage: [...coverage, ...settings.notes],
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

export const readClaudeListingSnapshot = Effect.fn("Listing.claudeDiscovery")(function* (
  state: LibraryState,
  options: ClaudeListingOptions,
) {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = <S extends Schema.Top>(path: string, schema: S) =>
      fs.readFileString(path).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
        Effect.mapError(
          (error) => new ListingReadFailure({ detail: `Cannot read ${path}: ${String(error)}` }),
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
    const envModel = yield* Config.option(Config.String("ANTHROPIC_MODEL"));
    const fixedBudget = yield* Config.option(Config.String("SLASH_COMMAND_TOOL_CHAR_BUDGET"));
    const rawLimit = Option.getOrNull(fixedBudget);
    const fixedLimit = rawLimit === null ? null : Number(rawLimit);
    let limit = fixedLimit;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0))
      return yield* new ListingReadFailure({
        detail: "SLASH_COMMAND_TOOL_CHAR_BUDGET must be a positive integer.",
      });
    const contract = harnessProfile("claude-code").skillListing!;
    const model = Option.getOrNull(envModel) ?? settings.model ?? null;
    const alias = model?.replace(/\[1m\]$/, "");
    const defaultModel =
      alias !== undefined && ["opus", "sonnet", "haiku", "fable"].includes(alias)
        ? Option.getOrNull(
            yield* Config.option(Config.String(`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`)),
          )
        : null;
    const resolvedModel = defaultModel ?? model;
    const contextWindow = Option.getOrNull(modelContextWindow("anthropic", resolvedModel));
    const conversion = contract.contextConversion;
    const fraction = settings.skillListingBudgetFraction ?? contract.fraction;
    if (limit === null && conversion !== undefined)
      limit = Math.max(
        1,
        Math.floor(
          (contextWindow ?? conversion.fallbackContextWindow) *
            conversion.charactersPerToken *
            fraction,
        ),
      );
    const limitSource =
      fixedLimit !== null
        ? "SLASH_COMMAND_TOOL_CHAR_BUDGET"
        : conversion === undefined
          ? "Limit unavailable: no context conversion recorded."
          : `Estimated from ${contextWindow === null ? "native fallback" : resolvedModel} context ${(contextWindow ?? conversion.fallbackContextWindow).toLocaleString("en-US")} × ${conversion.charactersPerToken} characters/token × ${fraction} (Claude Code ${conversion.clientVersion})`;
    const resolved: ClaudeListingSettings = {
      model: resolvedModel,
      modelSource: Option.isSome(envModel)
        ? "ANTHROPIC_MODEL"
        : (sources.get("model") ?? "not configured"),
      limit,
      limitSource,
      cap: settings.skillListingMaxDescChars ?? contract.descriptionCap,
      overrides: settings.skillOverrides ?? {},
      notes: [
        ...(overrideSources > 1
          ? [
              "skillOverrides merging across settings files is assumed to be per-key; native merge semantics are unverified.",
            ]
          : []),
        "Overrides match names only; managed alias matching is not modelled.",
        ...(settings.skillListingBudgetFraction === undefined
          ? []
          : [
              `Configured fraction ${settings.skillListingBudgetFraction} (${sources.get("skillListingBudgetFraction")}); ${fixedLimit === null ? "using native context conversion" : "using the explicit character override"}.`,
            ]),
        "Model aliases assume the current Anthropic API mapping; provider/version-specific mappings and session model/flags are not observable offline.",
      ],
    };
    const coverage = [
      `Combined description and when_to_use text is capped at ${resolved.cap} characters per entry.`,
      "Counts name, description and when_to_use with estimated row separators; native row formatting and invocation order are not observable.",
      "Identical named descriptions are counted once across copies; native precedence for differing descriptions is not predicted.",
      "Built-in skills, legacy commands, remote/synced and dynamically loaded nested skills may add demand. This is a partial filesystem estimate; full instructions loaded later are additional.",
    ];
    const roots: { root: string; namespace?: string }[] = [
      { root: resolve(options.overrides.claude ?? join(configDir, "skills")) },
    ];
    for (let current = resolve(options.cwd); current !== options.home; current = dirname(current)) {
      roots.push(
        ...harnessProfile("claude-code")
          .roots.filter((root) => root.readable && root.scope === "project")
          .map((root) => ({
            root: resolveHarnessRoot(root, {
              home: options.home,
              configHome: options.configHome,
              repository: current,
            }),
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
    for (const projection of state.projections) {
      const path = yield* fs
        .realPath(join(projection.path, "SKILL.md"))
        .pipe(
          Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound"
              ? Effect.succeed(resolve(projection.path, "SKILL.md"))
              : Effect.fail(e),
          ),
        );
      const skill = state.skills.find((s) => s.skill_id === projection.skill_id);
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
          Effect.mapError((e) => new ListingReadFailure({ detail: String(e) })),
        );
        if (canonical === null) return;
        const key = `${namespace ?? ""}\0${canonical}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (++count > 10000)
          return yield* new ListingReadFailure({
            detail: "Claude skill discovery exceeds 10,000 directories.",
          });
        const document = join(canonical, "SKILL.md");
        if (yield* fs.exists(document)) {
          const text = yield* fs.readFileString(document);
          const parsed = parseSkillFrontmatter(text);
          const fields = parsed ?? (text.startsWith("---") ? null : {});
          if (fields == null)
            return yield* new ListingReadFailure({
              detail: `Malformed skill metadata: ${document}`,
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
              coverage.push(`Skipped unavailable skill path: ${child}`);
              return Effect.succeed(null);
            }),
          );
          if (info?.type === "Directory") yield* walk(child, namespace);
        }
      }).pipe(
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new ListingReadFailure({ detail: String(e) })),
        ),
      );
    for (const root of roots) yield* walk(root.root, root.namespace);
    const visible = deduplicateClaudeEntries([...entries.values()]);
    return {
      entries: visible,
      settings: resolved,
      budget: claudeListingResult(options.cwd, visible, resolved, coverage),
    } satisfies ClaudeListingSnapshot;
  }).pipe(
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new ListingReadFailure({ detail: String(e) })),
    ),
    Effect.catchTag("ConfigError", (e) =>
      Effect.fail(new ListingReadFailure({ detail: String(e) })),
    ),
    Effect.catchTag("ListingReadFailure", (e) =>
      Effect.succeed({
        entries: [],
        budget: {
          _tag: "Unavailable" as const,
          harness: "claude-code" as const,
          cwd: options.cwd,
          detail: e.detail,
        },
      }),
    ),
  );
});
