import type { HarnessName, ProjectionTarget } from "../contracts.js";
import { projectionRoot } from "./catalog.js";
import type { HarnessRootContext } from "./contracts.js";

/**
 * The Harnesses whose native invocation metadata each target's copies carry. Cursor and Pi also
 * read `.agents/skills`, but SKIT has no invocation metadata to write for them.
 */
export const projectionTargetHarnesses = {
  agents: ["codex", "opencode", "devin"],
  claude: ["claude-code"],
} as const satisfies Record<ProjectionTarget, readonly HarnessName[]>;

/** The Harness profile whose writable root each target materializes into. */
const projectionTargetProfiles = {
  agents: "codex",
  claude: "claude-code",
} as const satisfies Record<ProjectionTarget, HarnessName>;

/** Resolve one target's writable Skill root for a scope. */
export function projectionTargetRoot(
  target: ProjectionTarget,
  scope: "global" | "project",
  context: HarnessRootContext,
): string {
  const root = projectionRoot(projectionTargetProfiles[target], scope, context);
  if (root === null) throw new Error(`Projection target has no ${scope} root: ${target}`);
  return root;
}
