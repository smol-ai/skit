import type { HarnessName } from "./contracts.js";
import type { InstallDestination } from "../installed-skills/destination.js";

/**
 * The Harnesses with dedicated invocation metadata carried by each target. Cursor and Pi also
 * read `.agents/skills`; install policy writes their shared `disable-model-invocation` field
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
