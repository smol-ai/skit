import type { InvocationReadModel } from "./invocation.js";
import { type InstallScope } from "../../scope.js";

export interface ScopeChoice {
  value: "global" | "repository";
  scope: InstallScope;
}

export interface InvocationScopeRow {
  readonly scope: InstallScope;
  readonly policy?: InvocationReadModel;
}

export function scopeKey(scope: InstallScope): string {
  return scope.kind === "global" ? "global" : `repository:${scope.root}`;
}

export function scopeChoices(cwd: string): ScopeChoice[] {
  return [
    { value: "global", scope: { kind: "global" } },
    {
      value: "repository",
      scope: { kind: "repository", root: cwd },
    },
  ];
}

export function invocationEligibleScopes<T extends InvocationScopeRow>(row: {
  readonly scopes: readonly T[];
}): readonly T[] {
  return row.scopes.filter((scopeRow) => scopeRow.policy !== undefined);
}

export { type InstallScope } from "../../scope.js";
