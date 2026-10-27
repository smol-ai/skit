import type { HarnessName, InstallDestination } from "../contracts.js";
import { installSkillsDirectory } from "./catalog.js";
import type { SkillsDirectoryContext } from "./contracts.js";

/**
 * The Harnesses with dedicated invocation metadata carried by each target. Cursor and Pi also
 * read `.agents/skills`; projection policy writes their shared `disable-model-invocation` field
 * separately, using the Claude adapter.
 */
export const installDestinationHarnesses = {
  agents: ["codex", "opencode", "devin"],
  claude: ["claude-code"],
} as const satisfies Record<InstallDestination, readonly HarnessName[]>;

/** The Harness profile whose writable root each target materializes into. */
export const installDestinationProfiles = {
  agents: "codex",
  claude: "claude-code",
} as const satisfies Record<InstallDestination, HarnessName>;

/** Resolve one target's writable Skill root for a scope. */
export function installDestinationDirectory(
  target: InstallDestination,
  scope: "global" | "project",
  context: SkillsDirectoryContext,
): string {
  const root = installSkillsDirectory(installDestinationProfiles[target], scope, context);
  if (root === null) throw new Error(`Projection target has no ${scope} root: ${target}`);
  return root;
}
