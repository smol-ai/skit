import { Result } from "effect";
import { harnessProfile } from "@smolai/skit-core";
import { harnessAliases, harnessLabel } from "../harness/catalog.js";
import { invocationHarnesses } from "../invocation/policy.js";
import {
  destinationLabel,
  invocationBriefing,
  invocationPolicyChoices,
  invocationRowSummary,
  type InvocationPolicyChoice,
  type InvocationReadModel,
} from "../invocation/read-model.js";
import { NoSupportedHarnesses } from "../harness/failures.js";
import type { HarnessName as Harness, SkitBindingScope as Scope } from "@smolai/skit-core";

export interface ScopeChoice {
  value: "global" | "repository";
  label: string;
  hint?: string;
  scope: Scope;
}

export interface HarnessChoice {
  value: Harness;
  label: string;
}

export interface InvocationBindingRow {
  readonly harness: Harness;
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

export function harnessChoices(candidates: readonly Harness[]): HarnessChoice[] {
  return candidates.map((harness) => ({ value: harness, label: harnessLabel(harness) }));
}

export function harnessSupportsScope(harness: Harness, scope: Scope["kind"]): boolean {
  const projection = harnessProfile(harness).projection;
  return (scope === "global" ? projection.globalTarget : projection.projectTarget) !== null;
}

export function eligibleHarnesses(options: {
  detected: readonly Harness[];
  requested?: Harness;
}): Result.Result<Harness[], NoSupportedHarnesses> {
  const candidates = options.requested ? [options.requested] : [...options.detected];
  return candidates.length
    ? Result.succeed(candidates)
    : Result.fail(new NoSupportedHarnesses({ aliases: harnessAliases }));
}

export function invocationEligibleBindings<T extends InvocationBindingRow>(row: {
  readonly bindings: readonly T[];
}): readonly T[] {
  return row.bindings.filter((binding) =>
    (invocationHarnesses as readonly Harness[]).includes(binding.harness),
  );
}

export type InvocationChoice = InvocationPolicyChoice;

export function invocationChoices(binding: InvocationBindingRow): InvocationChoice[] {
  return binding.policy ? invocationPolicyChoices(binding.policy) : [];
}

export function bindingRowLabel(binding: InvocationBindingRow): string {
  return [
    harnessLabel(binding.harness),
    destinationLabel(binding.scope),
    ...(binding.policy ? [invocationRowSummary(binding.policy)] : []),
  ].join(" · ");
}

export { destinationLabel, invocationBriefing, invocationRowSummary, harnessLabel };

export type { HarnessName as Harness, SkitBindingScope as Scope } from "@smolai/skit-core";
