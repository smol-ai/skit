import type { HarnessName, InvocationPolicy } from "../contracts.js";
import { Effect, FileSystem } from "effect";
import {
  applyHarnessInvocationPolicyEffect,
  type HarnessInvocationWriteFailure,
} from "../harnesses/projection.js";

export type InvocationIntent =
  | { source: "declared" }
  | { source: "override"; policy: InvocationPolicy };

export const declaredInvocationIntent = { source: "declared" } as const satisfies InvocationIntent;

export function overrideInvocationIntent(policy: InvocationPolicy): InvocationIntent {
  return { source: "override", policy };
}

/**
 * Normalize a Projection to the invocation policy in force. A published artifact already carries
 * its declaration, so this rewrites nothing for a conforming Skill; an undeclared Skill keeps the
 * native metadata its author shipped, which is the Agent Skills compatibility path.
 */
export function applyInvocationPolicyEffect(
  directory: string,
  harness: HarnessName,
  declaredPolicy: InvocationPolicy | undefined,
  intent: InvocationIntent = declaredInvocationIntent,
): Effect.Effect<void, HarnessInvocationWriteFailure, FileSystem.FileSystem> {
  const policy = intent.source === "declared" ? declaredPolicy : intent.policy;
  if (!policy) return Effect.void;
  return applyHarnessInvocationPolicyEffect(directory, harness, {
    source: intent.source,
    policy,
  }).pipe(Effect.asVoid);
}
