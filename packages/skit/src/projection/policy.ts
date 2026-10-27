import type { InvocationPolicy, InstallDestination } from "../contracts.js";
import { Effect, FileSystem } from "effect";
import {
  applyHarnessInvocationPolicy,
  type HarnessInvocationWriteFailure,
} from "../harnesses/projection.js";
import { installDestinationHarnesses } from "../harnesses/install-destinations.js";

export type InvocationIntent =
  | { source: "declared" }
  | { source: "override"; policy: InvocationPolicy };

export const declaredInvocationIntent = { source: "declared" } as const satisfies InvocationIntent;

export function overrideInvocationIntent(policy: InvocationPolicy): InvocationIntent {
  return { source: "override", policy };
}

/**
 * Normalize an installed skill to the invocation policy in force. A published artifact already carries
 * its declaration, so this rewrites nothing for a conforming Skill; an undeclared Skill keeps the
 * native metadata its author shipped, which is the Agent Skills compatibility path.
 */
export function applyInvocationPolicy(
  directory: string,
  target: InstallDestination,
  declaredPolicy: InvocationPolicy | undefined,
  intent: InvocationIntent = declaredInvocationIntent,
): Effect.Effect<void, HarnessInvocationWriteFailure, FileSystem.FileSystem> {
  const policy = intent.source === "declared" ? declaredPolicy : intent.policy;
  if (!policy) return Effect.void;
  // Each reader's native field lives in its own file or key, so one copy carries them all.
  // Cursor and Pi consume the same frontmatter field as Claude, but Claude is not a
  // reader of the shared target in our routing model. Keep that field writer separate
  // from the reader map used by inventory and setup.
  const adapters =
    target === "agents"
      ? [...installDestinationHarnesses[target], "claude-code" as const]
      : installDestinationHarnesses[target];
  return Effect.forEach(
    adapters,
    (harness) => applyHarnessInvocationPolicy(directory, harness, policy),
    { discard: true },
  );
}
