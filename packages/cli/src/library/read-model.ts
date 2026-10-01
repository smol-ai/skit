import {
  destinationLabel,
  invocationBriefing,
  invocationPolicyChoices,
  invocationRowSummary,
  type InvocationPolicyChoice,
  type InvocationReadModel,
} from "../invocation/read-model.js";
import type { SkitBindingScope as Scope } from "@smolai/skit-core";

export interface ScopeChoice {
  value: "global" | "repository";
  label: string;
  hint?: string;
  scope: Scope;
}

export interface InvocationBindingRow {
  readonly scope: Scope;
  readonly policy?: InvocationReadModel;
}

export function scopeKey(scope: Scope): string {
  return scope.kind === "global" ? "global" : `repository:${scope.root}`;
}

export function scopeChoices(cwd: string): ScopeChoice[] {
  return [
    { value: "global", label: "All projects", scope: { kind: "global" } },
    {
      value: "repository",
      label: "Only this repository",
      hint: cwd,
      scope: { kind: "repository", root: cwd },
    },
  ];
}

export const DESTINATION_QUESTION = "Where should this change apply?";

export function invocationEligibleBindings<T extends InvocationBindingRow>(row: {
  readonly bindings: readonly T[];
}): readonly T[] {
  return row.bindings.filter((binding) => binding.policy !== undefined);
}

export type InvocationChoice = InvocationPolicyChoice;

export function invocationChoices(binding: InvocationBindingRow): InvocationChoice[] {
  return binding.policy ? invocationPolicyChoices(binding.policy) : [];
}

export function bindingRowLabel(binding: InvocationBindingRow): string {
  return [
    destinationLabel(binding.scope),
    ...(binding.policy ? [invocationRowSummary(binding.policy)] : []),
  ].join(" · ");
}

export { destinationLabel, invocationBriefing, invocationRowSummary };

export type { SkitBindingScope as Scope } from "@smolai/skit-core";
