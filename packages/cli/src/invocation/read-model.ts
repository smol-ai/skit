// The one structured account of invocation policy both front ends render. It answers the
// operator's question — when may this Harness choose this Skill? — from the author's declaration,
// the device-local override, and what SKIT will actually project. It is pure: no prompts, no
// filesystem, no streams. Adapters render these strings; they do not re-derive them.

import {
  DeclaredInvocation,
  DeclaredPolicySource,
  DeclaredInvocationResolution,
  InvocationConformance,
  InvocationHarness,
  InvocationPolicy,
  LibraryInvocationOption,
  ResolvedDeclaredPolicy,
} from "@smolai/skit-core";
import { Schema } from "effect";
import { harnessLabel } from "../harness/catalog.js";
import type { InvocationOption } from "./policy.js";
import type { HarnessName as Harness, SkitBindingScope as Scope } from "@smolai/skit-core";

export type { InvocationHarness, ResolvedDeclaredPolicy };

/** Where the effective policy comes from, in the operator's terms rather than storage's. */
export const PolicySource = Schema.Literals(["author", "local-override", "harness-default"]);
export type PolicySource = typeof PolicySource.Type;

export const InvocationReadModel = Schema.Struct({
  harness: InvocationHarness,
  harnessLabel: Schema.String,
  skill: Schema.String,
  authorPolicy: ResolvedDeclaredPolicy,
  authorPolicySource: DeclaredPolicySource,
  authorDeclarations: Schema.Array(DeclaredInvocation),
  conformance: InvocationConformance,
  overridePolicy: Schema.optionalKey(InvocationPolicy),
  /** The policy SKIT will project for this Harness. `host-policy` means the Harness decides. */
  effectivePolicy: InvocationPolicy,
  policySource: PolicySource,
  /** The stored intent this Binding carries, unchanged: presentation never edits persistence. */
  storedIntent: LibraryInvocationOption,
  question: Schema.String,
  authorSummary: Schema.String,
  effectiveSummary: Schema.String,
  /** Present only when the artifact itself is at fault, in the operator's language. */
  defect: Schema.optionalKey(Schema.String),
});
export type InvocationReadModel = typeof InvocationReadModel.Type;

/** Decision-oriented names. The stored enum stays the enum; this is what a person reads. */
export function policyLabel(policy: InvocationPolicy, harness: Harness): string {
  if (policy === "implicit") return "Automatically";
  if (policy === "explicit") return "Only when asked";
  return `${harnessLabel(harness)} default`;
}

export function policyExplanation(policy: InvocationPolicy, harness: Harness): string {
  const label = harnessLabel(harness);
  if (policy === "implicit") return `${label} may choose this skill on its own when it fits.`;
  if (policy === "explicit")
    return harness === "opencode"
      ? "OpenCode V2 uses this skill only when you ask for it. OpenCode V1 ignores this setting."
      : `${label} uses this skill only when you ask for it.`;
  return `${label} decides, using its own default.`;
}

/** The author's default, named for the Harness it applies to, or said to be absent. */
export function authorPolicyLabel(policy: ResolvedDeclaredPolicy, harness: Harness): string {
  return policy === "unspecified" ? "Not specified" : policyLabel(policy, harness);
}

export function destinationLabel(scope: Scope): string {
  return scope.kind === "global" ? "All projects" : scope.root;
}

function conformanceDefect(
  conformance: InvocationConformance,
  skill: string,
  harness: Harness,
): string | undefined {
  const label = harnessLabel(harness);
  if (conformance.state === "non-conforming")
    return `‘${skill}’ contradicts itself: its author declared ${policyLabel(conformance.declared, harness).toLowerCase()}, but the published ${label} metadata in ${conformance.path} sets ${conformance.field} to ${policyLabel(conformance.native, harness).toLowerCase()}. Only the author can repair this.`;
  if (conformance.state === "unverified-legacy")
    return `‘${skill}’ was published before skills carried this setting in their own ${label} metadata: ${conformance.path} states no ${conformance.field}, so its compatibility outside SKIT is unverified.`;
  return undefined;
}

function effectiveSummary(model: {
  effectivePolicy: InvocationPolicy;
  policySource: PolicySource;
  harness: Harness;
  authorPolicy: ResolvedDeclaredPolicy;
}): string {
  const behaviour = policyExplanation(model.effectivePolicy, model.harness);
  if (model.policySource === "local-override") return `${behaviour} Set on this device.`;
  if (model.policySource === "author") return `${behaviour} Set by the author.`;
  return `${behaviour} The author did not specify a preference.`;
}

/**
 * Resolve one Binding's invocation policy into everything both front ends need to say about it.
 *
 * Precedence is local override, then the author's SKIT declaration, then the Harness's native
 * metadata, then the Harness's own default. In a conforming Release the middle two agree, so the
 * ordering decides nothing; it matters only for legacy and non-conforming artifacts.
 */
export function invocationReadModel(input: {
  skill: string;
  harness: InvocationHarness;
  author: DeclaredInvocationResolution;
  storedIntent: InvocationOption;
}): InvocationReadModel {
  const { skill, harness, author, storedIntent } = input;
  const overridePolicy = storedIntent === "declared" ? undefined : storedIntent;
  const effectivePolicy: InvocationPolicy =
    overridePolicy ?? (author.policy === "unspecified" ? "host-policy" : author.policy);
  const policySource: PolicySource = overridePolicy
    ? "local-override"
    : author.policy === "unspecified"
      ? "harness-default"
      : "author";
  return {
    harness,
    harnessLabel: harnessLabel(harness),
    skill,
    authorPolicy: author.policy,
    authorPolicySource: author.source,
    authorDeclarations: author.declarations,
    conformance: author.conformance,
    ...(overridePolicy ? { overridePolicy } : {}),
    effectivePolicy,
    policySource,
    storedIntent,
    question: `When can ${harnessLabel(harness)} use ‘${skill}’?`,
    authorSummary: `Author preference: ${authorPolicyLabel(author.policy, harness)}`,
    effectiveSummary: effectiveSummary({
      effectivePolicy,
      policySource,
      harness,
      authorPolicy: author.policy,
    }),
    ...(conformanceDefect(author.conformance, skill, harness)
      ? { defect: conformanceDefect(author.conformance, skill, harness)! }
      : {}),
  };
}

export interface InvocationPolicyChoice {
  value: InvocationOption;
  label: string;
  hint?: string;
}

/**
 * The four stored intents, named as decisions. `declared` resolves to whatever the author actually
 * declared, so the operator never has to know what "declared" would turn out to mean.
 */
export function invocationPolicyChoices(model: InvocationReadModel): InvocationPolicyChoice[] {
  const label = harnessLabel(model.harness);
  const authorDefault =
    model.authorPolicy === "unspecified"
      ? `Author preference — none (${label} default)`
      : `Author preference — ${authorPolicyLabel(model.authorPolicy, model.harness).toLowerCase()}`;
  const options: InvocationPolicyChoice[] = [
    { value: "declared", label: authorDefault },
    { value: "implicit", label: policyLabel("implicit", model.harness) },
    { value: "explicit", label: policyLabel("explicit", model.harness) },
    { value: "host-policy", label: policyLabel("host-policy", model.harness) },
  ];
  return options.map((option) =>
    option.value === model.storedIntent ? { ...option, hint: "current" } : option,
  );
}

/**
 * What a screen says about the author, the operator's own setting, and the resulting behaviour
 * before asking them to decide. Both front ends show this; neither writes its own version.
 */
export function invocationBriefing(policy: InvocationReadModel): string {
  const current = policyLabel(policy.effectivePolicy, policy.harness);
  const source =
    policy.policySource === "local-override"
      ? "set on this device"
      : policy.policySource === "author"
        ? "author preference"
        : "no author preference";
  return [
    ...(policy.overridePolicy ? [policy.authorSummary] : []),
    `Current: ${current} (${source})`,
    ...(policy.defect ? ["", policy.defect] : []),
  ].join("\n");
}

/** The one-line account of a Binding shown in Library rows and choosers. */
export function invocationRowSummary(model: InvocationReadModel): string {
  if (model.policySource === "harness-default")
    return policyLabel(model.effectivePolicy, model.harness);
  const source = model.policySource === "local-override" ? "you" : "author";
  return `${policyLabel(model.effectivePolicy, model.harness)} · ${source}`;
}
