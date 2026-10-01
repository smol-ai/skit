// The one structured account of invocation policy both front ends render. It answers the
// operator's question — when may an agent choose this Skill? — from the author's declaration,
// the device-local override, and what SKIT will actually project. It is pure: no prompts, no
// filesystem, no streams. Adapters render these strings; they do not re-derive them.

import {
  DeclaredInvocation,
  DeclaredPolicySource,
  DeclaredInvocationResolution,
  InvocationConformance,
  InvocationPolicy,
  LibraryInvocationOption,
  ResolvedDeclaredPolicy,
} from "@smolai/skit-core";
import { Schema } from "effect";
import type { InvocationOption } from "./policy.js";
import type { SkitBindingScope as Scope } from "@smolai/skit-core";

export type { ResolvedDeclaredPolicy };

/** Where the effective policy comes from, in the operator's terms rather than storage's. */
export const PolicySource = Schema.Literals(["author", "local-override", "harness-default"]);
export type PolicySource = typeof PolicySource.Type;

export const InvocationReadModel = Schema.Struct({
  skill: Schema.String,
  authorPolicy: ResolvedDeclaredPolicy,
  authorPolicySource: DeclaredPolicySource,
  authorDeclarations: Schema.Array(DeclaredInvocation),
  conformance: InvocationConformance,
  overridePolicy: Schema.optionalKey(InvocationPolicy),
  /** The policy SKIT will project for every agent. `host-policy` means each agent decides. */
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
export function policyLabel(policy: InvocationPolicy): string {
  if (policy === "implicit") return "Automatically";
  if (policy === "explicit") return "Only when asked";
  return "Agent default";
}

export function policyExplanation(policy: InvocationPolicy): string {
  if (policy === "implicit") return "Agents may choose this skill on their own when it fits.";
  if (policy === "explicit")
    return "Agents use this skill only when you ask for it. OpenCode V1 ignores this setting.";
  return "Each agent decides, using its own default.";
}

/** The author's default, or said to be absent. */
export function authorPolicyLabel(policy: ResolvedDeclaredPolicy): string {
  return policy === "unspecified" ? "Not specified" : policyLabel(policy);
}

export function destinationLabel(scope: Scope): string {
  return scope.kind === "global" ? "All projects" : scope.root;
}

function conformanceDefect(conformance: InvocationConformance, skill: string): string | undefined {
  if (conformance.state === "non-conforming")
    return `‘${skill}’ contradicts itself: its author declared ${policyLabel(conformance.declared).toLowerCase()}, but the published metadata in ${conformance.path} sets ${conformance.field} to ${policyLabel(conformance.native).toLowerCase()}. Only the author can repair this.`;
  if (conformance.state === "unverified-legacy")
    return `‘${skill}’ was published before skills carried this setting in their own metadata: ${conformance.path} states no ${conformance.field}, so its compatibility outside SKIT is unverified.`;
  return undefined;
}

function effectiveSummary(model: {
  effectivePolicy: InvocationPolicy;
  policySource: PolicySource;
  authorPolicy: ResolvedDeclaredPolicy;
}): string {
  const behaviour = policyExplanation(model.effectivePolicy);
  if (model.policySource === "local-override") return `${behaviour} Set on this device.`;
  if (model.policySource === "author") return `${behaviour} Set by the author.`;
  return `${behaviour} The author did not specify a preference.`;
}

/**
 * Resolve one Binding's invocation policy into everything both front ends need to say about it.
 * One policy applies to every agent; SKIT writes it into each agent's native metadata.
 *
 * Precedence is local override, then the author's SKIT declaration, then native metadata, then
 * each agent's own default. In a conforming Release the middle two agree, so the
 * ordering decides nothing; it matters only for legacy and non-conforming artifacts.
 */
export function invocationReadModel(input: {
  skill: string;
  author: Omit<DeclaredInvocationResolution, "harness">;
  storedIntent: InvocationOption;
}): InvocationReadModel {
  const { skill, author, storedIntent } = input;
  const overridePolicy = storedIntent === "declared" ? undefined : storedIntent;
  const effectivePolicy: InvocationPolicy =
    overridePolicy ?? (author.policy === "unspecified" ? "host-policy" : author.policy);
  const policySource: PolicySource = overridePolicy
    ? "local-override"
    : author.policy === "unspecified"
      ? "harness-default"
      : "author";
  return {
    skill,
    authorPolicy: author.policy,
    authorPolicySource: author.source,
    authorDeclarations: author.declarations,
    conformance: author.conformance,
    ...(overridePolicy ? { overridePolicy } : {}),
    effectivePolicy,
    policySource,
    storedIntent,
    question: `When can agents use ‘${skill}’?`,
    authorSummary: `Author preference: ${authorPolicyLabel(author.policy)}`,
    effectiveSummary: effectiveSummary({
      effectivePolicy,
      policySource,
      authorPolicy: author.policy,
    }),
    ...(conformanceDefect(author.conformance, skill)
      ? { defect: conformanceDefect(author.conformance, skill)! }
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
  const authorDefault =
    model.authorPolicy === "unspecified"
      ? "Author preference — none (agent default)"
      : `Author preference — ${authorPolicyLabel(model.authorPolicy).toLowerCase()}`;
  const options: InvocationPolicyChoice[] = [
    { value: "declared", label: authorDefault },
    { value: "implicit", label: policyLabel("implicit") },
    { value: "explicit", label: policyLabel("explicit") },
    { value: "host-policy", label: policyLabel("host-policy") },
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
  const current = policyLabel(policy.effectivePolicy);
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
  if (model.policySource === "harness-default") return policyLabel(model.effectivePolicy);
  const source = model.policySource === "local-override" ? "you" : "author";
  return `${policyLabel(model.effectivePolicy)} · ${source}`;
}
