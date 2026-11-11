import { Schema } from "effect";

/** The native discovery transport selected by its driver. */
export const DiscoveryProtocol = Schema.Literals([
  "codex-app-server",
  "claude-control-initialize",
  "opencode-debug-skill",
  "opencode-http-v2",
  "devin-skills-list",
]);
export type DiscoveryProtocol = typeof DiscoveryProtocol.Type;
