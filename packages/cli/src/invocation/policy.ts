import { type HarnessName, type InvocationIntent } from "@smolai/skit-core";
import { UnknownInvocationPolicy } from "./failures.js";

export const invocationOptions = ["declared", "explicit", "implicit", "host-policy"] as const;
export type InvocationOption = (typeof invocationOptions)[number];

/** Harnesses whose Projections carry a model invocation policy. */
export const invocationHarnesses = [
  "claude-code",
  "codex",
  "opencode",
  "devin",
] as const satisfies readonly HarnessName[];

export function invocationSelectionFor(option: InvocationOption): InvocationIntent {
  return option === "declared" ? { source: "declared" } : { source: "override", policy: option };
}

export function parseInvocationOption(
  value: string | undefined,
): { option: InvocationOption; selection: InvocationIntent } | undefined {
  if (!value) return undefined;
  const option = invocationOptions.find((candidate) => candidate === value);
  if (!option) throw new UnknownInvocationPolicy({ value });
  return { option, selection: invocationSelectionFor(option) };
}
