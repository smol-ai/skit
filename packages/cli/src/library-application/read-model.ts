import {
  destinationLabel,
  invocationBriefing,
  invocationPolicyChoices,
  invocationRowSummary,
  type InvocationPolicyChoice,
  type InvocationReadModel,
} from "../invocation/read-model.js";
import type { InstallScope as Scope } from "@smolai/skit-core";

export interface ScopeChoice {
  value: "global" | "repository";
  label: string;
  hint?: string;
  scope: Scope;
}

export interface InvocationScopeRow {
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

export function invocationEligibleScopes<T extends InvocationScopeRow>(row: {
  readonly scopes: readonly T[];
}): readonly T[] {
  return row.scopes.filter((scopeRow) => scopeRow.policy !== undefined);
}

export type InvocationChoice = InvocationPolicyChoice;

export function invocationChoices(scopeRow: InvocationScopeRow): InvocationChoice[] {
  return scopeRow.policy ? invocationPolicyChoices(scopeRow.policy) : [];
}

export function scopeRowLabel(scopeRow: InvocationScopeRow): string {
  return [
    destinationLabel(scopeRow.scope),
    ...(scopeRow.policy ? [invocationRowSummary(scopeRow.policy)] : []),
  ].join(" · ");
}

export { destinationLabel, invocationBriefing, invocationRowSummary };

export type { InstallScope as Scope } from "@smolai/skit-core";
