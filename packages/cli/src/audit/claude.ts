import { Effect } from "effect";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  arrayAt,
  booleanAt,
  isJsonObject,
  objectAt,
  objectEntriesAt,
  stringAt,
  type JsonObject,
} from "@smolai/skit-core";
import type { AuditFinding, AuditObservation } from "./types.js";
import { canonical, pathExists, read, readJson, walk } from "./io.js";
import { addMcp } from "./mcp.js";
import { fileProvenance } from "./provenance.js";
import type { SkillCandidate } from "./skills.js";

function absolutePath(value: string | null | undefined): string | null {
  return typeof value === "string" && isAbsolute(value) ? value : null;
}

function marketplaceSource(registration: JsonObject): string | null {
  const source = objectAt(registration, "source");
  return source ? (stringAt(source, "repo") ?? stringAt(source, "url")) : null;
}

function mcpServersOf(source: JsonObject | null): JsonObject | undefined {
  return objectAt(source ?? {}, "mcpServers") ?? undefined;
}

export const auditClaude = Effect.fn("Audit.claude")(function* (
  home: string,
  cwd: string,
  lock: JsonObject,
) {
  const observations: AuditObservation[] = [];
  const findings: AuditFinding[] = [];
  const advertisedMcp = new Map<string, Set<string>>();
  const skills: SkillCandidate[] = [];
  for (const [scope, rulesRoot] of [
    ["user", join(home, ".claude", "rules")],
    ["project", join(cwd, ".claude", "rules")],
  ] as const)
    for (const path of yield* walk(rulesRoot, (candidate) => candidate.endsWith(".md"))) {
      const body = (yield* read(path)) ?? "";
      observations.push({
        kind: "rule",
        name: relative(rulesRoot, path),
        harnesses: ["claude-code"],
        scope,
        path,
        provenance: yield* fileProvenance(path, lock, basename(path)),
      });
      for (const match of body.matchAll(/mcp__([a-zA-Z0-9_-]+)__/g)) {
        const paths = advertisedMcp.get(match[1]) ?? new Set<string>();
        paths.add(path);
        advertisedMcp.set(match[1], paths);
      }
    }

  const configPath = join(home, ".claude.json");
  const config = (yield* readJson(configPath)) ?? {};
  addMcp(observations, configPath, "claude-code", "user", mcpServersOf(config), true);
  for (const [, project] of objectEntriesAt(config, "projects"))
    addMcp(observations, configPath, "claude-code", "project", mcpServersOf(project), true);
  const projectMcpPath = join(cwd, ".mcp.json");
  addMcp(
    observations,
    projectMcpPath,
    "claude-code",
    "project",
    mcpServersOf(yield* readJson(projectMcpPath)),
    true,
  );
  const legacyPath = join(home, ".claude", "settings.json");
  const legacy = yield* readJson(legacyPath);
  addMcp(observations, legacyPath, "claude-code", "legacy", mcpServersOf(legacy), false);
  for (const [name, server] of objectEntriesAt(legacy ?? {}, "mcpServers"))
    if (server.enabled !== false)
      findings.push({
        severity: "warning",
        code: "claude-mcp-registration-unsupported-location",
        subject: name,
        problem: `MCP server “${name}” is registered in an unsupported location`,
        locations: [legacyPath, ...(advertisedMcp.get(name) ?? [])],
        details: {
          server: name,
          registrationPath: legacyPath,
          advertisingPaths: [...(advertisedMcp.get(name) ?? [])],
        },
      });

  const installedPath = join(home, ".claude", "plugins", "installed_plugins.json");
  const installed = objectAt((yield* readJson(installedPath)) ?? {}, "plugins") ?? {};
  const marketplacesPath = join(home, ".claude", "plugins", "known_marketplaces.json");
  const marketplaces = (yield* readJson(marketplacesPath)) ?? {};
  const defaults = new Map<string, boolean>();
  for (const [marketplace, registration] of Object.entries(marketplaces).filter(
    (entry): entry is [string, JsonObject] => isJsonObject(entry[1]),
  )) {
    const location = stringAt(registration, "installLocation");
    observations.push({
      kind: "marketplace",
      name: marketplace,
      harnesses: ["claude-code"],
      scope: "user",
      path: location ?? marketplacesPath,
      source: marketplaceSource(registration) ?? location,
      provenance: {
        confidence: "exact",
        source: "Claude marketplace registry",
        evidence: marketplacesPath,
      },
    });
    const root = absolutePath(location);
    const catalogue = root
      ? yield* readJson(join(root, ".claude-plugin", "marketplace.json"))
      : null;
    for (const plugin of arrayAt(catalogue ?? {}, "plugins")) {
      if (!isJsonObject(plugin)) continue;
      const name = stringAt(plugin, "name");
      const enabled = booleanAt(plugin, "defaultEnabled");
      if (name !== null && enabled !== null) defaults.set(`${name}@${marketplace}`, enabled);
    }
  }
  const enablementSources: JsonObject[] = [];
  for (const path of [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    legacyPath,
  ])
    enablementSources.push(objectAt((yield* readJson(path)) ?? {}, "enabledPlugins") ?? {});
  const enabled = (name: string): boolean | null => {
    for (const source of enablementSources) {
      const value = booleanAt(source, name);
      if (value !== null) return value;
    }
    return defaults.get(name) ?? null;
  };
  for (const [name, installs] of Object.entries(installed))
    for (const install of Array.isArray(installs) ? installs : []) {
      if (!isJsonObject(install)) continue;
      const installPath = absolutePath(stringAt(install, "installPath"));
      const scope = stringAt(install, "scope") === "project" ? "project" : "user";
      observations.push({
        kind: "plugin",
        name,
        harnesses: ["claude-code"],
        scope,
        path: installPath,
        installed: true,
        enabled: enabled(name),
        provenance: {
          confidence: "exact",
          source: "Claude plugin registry",
          evidence: installedPath,
        },
      });
      if (!installPath || !(yield* pathExists(installPath)))
        findings.push({
          severity: "warning",
          code: "installed-claude-plugin-payload-missing",
          subject: name,
          problem: `Claude plugin “${name}” is registered as installed, but its files are missing`,
          locations: installPath ? [installPath] : [installedPath],
          details: { plugin: name, installPath },
        });
      const payloadSkills = installPath
        ? yield* walk(join(installPath, "skills"), (candidate) => candidate.endsWith("/SKILL.md"))
        : [];
      for (const path of payloadSkills) {
        skills.push({
          path,
          canonicalPath: yield* canonical(path),
          name: `${name}:${basename(dirname(path))}`,
          harnesses: ["claude-code"],
          // Plugin payloads execute through Claude's native plugin skill loader.
          role: "native",
          scope,
          provenance: {
            confidence: "exact",
            source: "Claude plugin registry",
            evidence: installedPath,
            parentPlugin: name,
          },
        });
      }
    }
  const installedNames = new Set(Object.keys(installed));
  for (const name of new Set([
    ...enablementSources.flatMap((source) => Object.keys(source)),
    ...defaults.keys(),
  ]))
    if (!installedNames.has(name) && enabled(name) === true) {
      observations.push({
        kind: "plugin",
        name,
        harnesses: ["claude-code"],
        scope: "user",
        path: null,
        installed: false,
        enabled: true,
        provenance: { confidence: "exact", source: "Claude enabledPlugins", evidence: legacyPath },
      });
      findings.push({
        severity: "warning",
        code: "enabled-claude-plugin-not-installed",
        subject: name,
        problem: `Claude plugin “${name}” is enabled but not installed`,
        locations: [legacyPath],
        details: { plugin: name },
      });
    }
  return { observations, findings, advertisedMcp, skills };
});
