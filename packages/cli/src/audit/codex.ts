import { dirname, join, relative } from "node:path";
import {
  booleanAt,
  isJsonObject,
  objectAt,
  objectEntriesAt,
  stringAt,
  type JsonObject,
  type JsonValue,
} from "@smolai/skit-core";
import type { AuditFinding, AuditObservation } from "./types.js";
import { Effect } from "effect";
import { errorMessage } from "../presentation/command-errors.js";
import { canonical, read, walk } from "./io.js";
import { addMcp } from "./mcp.js";

function tomlPath(source: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quote: string | null = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\" && quote === '"' && index + 1 < source.length) part += source[++index];
      else if (character === quote) quote = null;
      else part += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ".") {
      parts.push(part.trim());
      part = "";
    } else part += character;
  }
  if (quote) throw new Error("unterminated quoted table key");
  if (part.trim()) parts.push(part.trim());
  return parts;
}

function tomlValue(source: string): JsonValue {
  const value = source.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    return value[0] === "'" ? value.slice(1, -1) : JSON.parse(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const matches = value.slice(1, -1).match(/"(?:\\.|[^"\\])*"|'[^']*'|[^,]+/g) ?? [];
    return matches.map((item) => tomlValue(item));
  }
  return value;
}

function nestedTable(table: JsonObject, key: string): JsonObject {
  const existing = table[key];
  if (isJsonObject(existing)) return existing;
  const created: JsonObject = {};
  table[key] = created;
  return created;
}

function parseToml(source: string | null): { value: JsonObject | null; error: string | null } {
  if (source === null) return { value: {}, error: null };
  const value: JsonObject = {};
  let table: JsonObject = value;
  try {
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[") && line.endsWith("]")) {
        table = value;
        for (const key of tomlPath(line.slice(1, -1))) table = nestedTable(table, key);
        continue;
      }
      const assignment = line.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (!assignment) throw new Error(`unsupported line: ${line}`);
      const keys = tomlPath(assignment[1]);
      let target = table;
      for (const key of keys.slice(0, -1)) target = nestedTable(target, key);
      target[keys.at(-1)!] = tomlValue(assignment[2]);
    }
    return { value, error: null };
  } catch (error) {
    return { value: null, error: errorMessage(error) };
  }
}

function pluginEnabled(plugins: JsonObject, name: string): boolean {
  const entry = plugins[name];
  return isJsonObject(entry) && booleanAt(entry, "enabled") === true;
}

const codexProjectMcp = Effect.fn("Audit.codexProjectMcp")(function* (
  config: JsonObject,
  cwd: string,
) {
  const observations: AuditObservation[] = [];
  const findings: AuditFinding[] = [];
  const canonicalCwd = yield* canonical(cwd);
  const projects = objectAt(config, "projects") ?? {};
  let trustEntry: [string, unknown] | undefined;
  for (const entry of Object.entries(projects))
    if ((yield* canonical(entry[0])) === canonicalCwd) {
      trustEntry = entry;
      break;
    }
  if (!trustEntry || !isJsonObject(trustEntry[1])) return { observations, findings };
  if (stringAt(trustEntry[1], "trust_level") !== "trusted") return { observations, findings };

  const configPath = join(cwd, ".codex", "config.toml");
  const parsed = parseToml(yield* read(configPath));
  if (parsed.error)
    findings.push({
      severity: "warning",
      code: "codex-project-config-parse-failed",
      subject: configPath,
      problem: "Codex project configuration could not be parsed",
      locations: [configPath],
      details: { configPath, parseError: parsed.error },
    });
  else
    addMcp(
      observations,
      configPath,
      "codex",
      "project",
      objectAt(parsed.value ?? {}, "mcp_servers") ?? undefined,
      true,
    );
  return { observations, findings };
});

export const auditCodex = Effect.fn("Audit.codex")(function* (home: string, cwd: string) {
  const observations: AuditObservation[] = [];
  const findings: AuditFinding[] = [];
  const configPath = join(home, ".codex", "config.toml");
  const parsed = parseToml(yield* read(configPath));
  if (parsed.error)
    findings.push({
      severity: "warning",
      code: "codex-config-parse-failed",
      subject: configPath,
      problem: "Codex user configuration could not be parsed",
      locations: [configPath],
      details: { configPath, parseError: parsed.error },
    });
  const config = parsed.value ?? {};
  addMcp(
    observations,
    configPath,
    "codex",
    "user",
    objectAt(config, "mcp_servers") ?? undefined,
    true,
  );
  const project = yield* codexProjectMcp(config, cwd);
  observations.push(...project.observations);
  findings.push(...project.findings);
  for (const [name, marketplace] of objectEntriesAt(config, "marketplaces"))
    observations.push({
      kind: "marketplace",
      name,
      harnesses: ["codex"],
      scope: "user",
      path: configPath,
      source: stringAt(marketplace, "source") ?? configPath,
      provenance: { confidence: "exact", source: "Codex configuration", evidence: configPath },
    });

  const configured = objectAt(config, "plugins") ?? {};
  const cacheRoot = join(home, ".codex", "plugins", "cache");
  const cached = new Set<string>();
  const manifests = yield* walk(cacheRoot, (path) => path.endsWith("/.codex-plugin/plugin.json"));
  for (const manifest of manifests) {
    const parts = relative(cacheRoot, dirname(dirname(manifest))).split(/[\\/]/);
    if (parts.length < 3) continue;
    const [marketplace, plugin] = parts;
    const name = `${plugin}@${marketplace}`;
    cached.add(name);
    observations.push({
      kind: "plugin",
      name,
      harnesses: ["codex"],
      scope: "user",
      path: dirname(dirname(manifest)),
      installed: true,
      enabled: pluginEnabled(configured, name),
      provenance: { confidence: "exact", source: "Codex plugin cache", evidence: manifest },
    });
  }
  for (const name of Object.keys(configured)) {
    if (cached.has(name)) continue;
    const enabled = pluginEnabled(configured, name);
    observations.push({
      kind: "plugin",
      name,
      harnesses: ["codex"],
      scope: "user",
      path: null,
      installed: false,
      enabled,
      provenance: { confidence: "exact", source: "Codex configuration", evidence: configPath },
    });
    if (enabled)
      findings.push({
        severity: "warning",
        code: "enabled-codex-plugin-not-cached",
        subject: name,
        problem: `Codex plugin “${name}” is enabled but its installed files were not found`,
        locations: [configPath],
        details: { plugin: name, configPath },
      });
  }
  return { observations, findings };
});
