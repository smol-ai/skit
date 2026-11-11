import type { DiscoveryProtocol } from "@smolai/skit-core/harnesses/discovery-contracts";
import { harnessLabel, type HarnessName } from "@smolai/skit-core/harnesses";

const limitations = {
  "codex-app-server": [
    "Enabled skills reported by Codex's native discovery. Disabled skills are excluded; skill bodies are not loaded.",
  ],
  "claude-control-initialize": [
    "Callable commands only; may include legacy and bundled commands. Non-user-invocable skills and file paths are not exposed. Hooks and MCP startup are disabled.",
  ],
  "opencode-debug-skill": [
    "Resolved skills only: duplicate names can replace earlier entries. Native warnings may reveal collisions; the final list cannot prove their absence. Skill bodies are omitted.",
  ],
  "opencode-http-v2": [
    "Registered skills after discovery plugin activation and three stable metadata snapshots. Duplicate filesystem IDs follow native precedence without warnings; equal display names can coexist. Skill bodies are omitted.",
  ],
  "devin-skills-list": [
    "Native skill list; completeness across duplicate paths has not been established.",
  ],
} satisfies Record<DiscoveryProtocol, readonly string[]>;

export const discoveryLimitations = (protocol: DiscoveryProtocol): readonly string[] =>
  limitations[protocol];

export function rootOverrideDetail(harness: HarnessName, roots: readonly string[]): string {
  const flag = {
    codex: "--codex-root",
    "claude-code": "--claude-root",
    opencode: "--opencode-root",
    devin: "--devin-root",
  }[harness];
  return `Custom ${harnessLabel(harness)} skill directories were supplied: ${roots.join(", ")}. Run \`skit doctor\` without ${flag} to check native discovery.`;
}
