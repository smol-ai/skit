import { Effect } from "effect";
import { LinkStat } from "@smolai/skit-core";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  harnessProfile,
  hasHarnessProfile,
  resolveHarnessRoot,
  type HarnessName,
} from "@smolai/skit-core";

export const harnessRoster = [
  { id: "codex", aliases: ["codex"], label: "Codex", audit: "supported", target: true },
  {
    id: "claude-code",
    aliases: ["claude", "claude-code"],
    label: "Claude Code",
    audit: "supported",
    target: true,
  },
  {
    id: "opencode",
    aliases: ["opencode"],
    label: "OpenCode",
    audit: "supported",
    target: true,
  },
  { id: "devin", aliases: ["devin"], label: "Devin", audit: "supported", target: true },
  { id: "cursor", aliases: [], label: "Cursor", audit: "deferred", target: false },
  { id: "pi", aliases: [], label: "Pi", audit: "deferred", target: false },
] as const satisfies readonly {
  id: string;
  aliases: readonly string[];
  label: string;
  audit: "supported" | "deferred";
  target: boolean;
}[];

export const targetHarnesses = harnessRoster.filter((item) => item.target);
export const harnessAliases = targetHarnesses.flatMap((item) => item.aliases);
export const auditHarnesses = harnessRoster.filter((item) => item.audit === "supported");
export const deferredAuditHarnesses = harnessRoster
  .filter((item) => item.audit === "deferred")
  .map((item) => item.id);

function assertHarnessRoster(): void {
  const aliases = new Set<string>();
  for (const entry of harnessRoster) {
    if ((entry.audit === "supported" || entry.target) && !hasHarnessProfile(entry.id))
      throw new Error(`Harness roster entry has no core profile: ${entry.id}`);
    for (const alias of entry.aliases) {
      if (aliases.has(alias)) throw new Error(`Duplicate harness alias: ${alias}`);
      aliases.add(alias);
    }
  }
}

assertHarnessRoster();

export function harnessFromAlias(alias: string): HarnessName | undefined {
  return targetHarnesses.find((item) => (item.aliases as readonly string[]).includes(alias))?.id;
}

export function harnessLabel(harness: HarnessName): string {
  return harnessRoster.find((item) => item.id === harness)?.label ?? harness;
}

export interface HarnessProbeOptions {
  home?: string;
  configHome?: string;
  codexRoot?: string;
  claudeRoot?: string;
  opencodeRoot?: string;
  /** Extra Devin roots to scan; these do not establish Harness availability. */
  devinRoots?: string[];
  /** Whether a filesystem marker is present. Detection is a pure decision over this probe. */
  exists: (path: string) => boolean;
}

/** The detection policy over an answered marker probe; `detectInstalledHarnessesEffect` asks the filesystem. */
export function detectInstalledHarnesses(options: HarnessProbeOptions): HarnessName[] {
  const home = options.home ?? homedir();
  const configHome = options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const exists = options.exists;
  const detected: HarnessName[] = [];
  const context = { home, configHome };
  const installed = (harness: HarnessName) => {
    const native = harnessProfile(harness).roots.find(
      (root) => root.scope === "global" && root.role === "native",
    );
    return native ? exists(dirname(resolveHarnessRoot(native, context))) : false;
  };
  if (options.codexRoot || installed("codex") || exists("/etc/codex")) detected.push("codex");
  if (options.claudeRoot || installed("claude-code")) detected.push("claude-code");
  if (options.opencodeRoot || installed("opencode")) detected.push("opencode");
  if (installed("devin")) detected.push("devin");
  return detected;
}

/** Resolve the same synchronous detection policy with application-owned filesystem probes. */
export const detectInstalledHarnessesEffect = Effect.fn("Harness.detectInstalled")(function* (
  options: Omit<HarnessProbeOptions, "exists"> = {},
) {
  const paths = new Set<string>();
  detectInstalledHarnesses({
    ...options,
    exists: (path) => {
      paths.add(path);
      return false;
    },
  });
  const probe = yield* LinkStat;
  const found = new Set<string>();
  for (const path of paths) {
    const info = yield* Effect.option(probe.identity.lstat(path));
    if (info._tag === "Some") found.add(path);
  }
  return detectInstalledHarnesses({ ...options, exists: (path) => found.has(path) });
});
