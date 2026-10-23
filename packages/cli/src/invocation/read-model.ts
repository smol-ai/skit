// The structured account of invocation policy both front ends render: author declarations,
// the local override, and what projection will write. Pure: no filesystem, prompts or streams.
// Author evidence is per agent; a plain Skill can carry different policies in one shared copy.
import {
  DeclaredInvocation,
  DeclaredPolicySource,
  DeclaredInvocationResolution,
  HarnessName,
  InvocationConformance,
  InvocationPolicy,
  invocationMetadataAdapters,
  LibraryInvocationOption,
  ResolvedDeclaredPolicy,
} from "@smolai/skit-core";
import { Record, Schema } from "effect";
import { harnessLabel } from "../harness/catalog.js";
import type { InvocationOption } from "./policy.js";
import type { SkitBindingScope as Scope } from "@smolai/skit-core";

export type { ResolvedDeclaredPolicy };

export const AuthorInvocation = Schema.Record(HarnessName, DeclaredInvocationResolution);
export type AuthorInvocation = typeof AuthorInvocation.Type;

const PolicySource = Schema.Literals(["author", "local-override", "harness-default"]);
const AgentInvocation = Schema.Struct({
  authorPolicy: ResolvedDeclaredPolicy,
  authorPolicySource: DeclaredPolicySource,
  authorDeclarations: Schema.Array(DeclaredInvocation),
  conformance: InvocationConformance,
  /** Policy the adapter will leave in this agent's copy; host-policy delegates to its default. */
  effectivePolicy: InvocationPolicy,
  policySource: PolicySource,
});

export const InvocationReadModel = Schema.Struct({
  skill: Schema.String,
  agents: Schema.Record(HarnessName, AgentInvocation),
  overridePolicy: Schema.optionalKey(InvocationPolicy),
  /** Presentation never edits the persisted intent. */
  storedIntent: LibraryInvocationOption,
  question: Schema.String,
  authorSummary: Schema.String,
  effectiveSummary: Schema.String,
  /** Present only when the artifact itself fails to demonstrate its declaration. */
  defect: Schema.optionalKey(Schema.String),
});
export type InvocationReadModel = typeof InvocationReadModel.Type;

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

const agentEntries = (model: Pick<InvocationReadModel, "agents">) =>
  HarnessName.literals.map((harness) => ({ harness, ...model.agents[harness] }));

const authorPreference = (model: Pick<InvocationReadModel, "agents">): string => {
  const policy = model.agents.codex.authorPolicy;
  return agentEntries(model).every((agent) => agent.authorPolicy === policy)
    ? authorPolicyLabel(policy)
    : "Varies by agent";
};

/** Match projection: an override or descriptor policy is written; otherwise native fields survive. */
export function invocationReadModel(input: {
  skill: string;
  author: AuthorInvocation;
  storedIntent: InvocationOption;
}): InvocationReadModel {
  const { skill, author, storedIntent } = input;
  const overridePolicy = storedIntent === "declared" ? undefined : storedIntent;
  const defects = new Set<string>();
  const agents = Record.map(author, (declared, harness): typeof AgentInvocation.Type => {
    let effectivePolicy =
      overridePolicy ?? (declared.policy === "unspecified" ? "host-policy" : declared.policy);
    let policySource: typeof PolicySource.Type = overridePolicy
      ? "local-override"
      : declared.policy === "unspecified"
        ? "harness-default"
        : "author";
    // Read and write policy share the adapter's default-preservation rule.
    if (
      invocationMetadataAdapters[harness].hostPolicyPreservesNative &&
      effectivePolicy === "host-policy"
    ) {
      const native = declared.declarations.find((item) => item.origin === "native-metadata");
      if (native !== undefined) {
        effectivePolicy = native.policy;
        policySource = "author";
      }
    }
    const agent = {
      authorPolicy: declared.policy,
      authorPolicySource: declared.source,
      authorDeclarations: declared.declarations,
      conformance: declared.conformance,
      effectivePolicy,
      policySource,
    };
    const defect = conformanceDefect(declared.conformance, skill);
    if (defect !== undefined) defects.add(`${harnessLabel(harness)}: ${defect}`);
    return agent;
  });
  const entries = agentEntries({ agents });
  const common = agents.codex;
  const uniform = entries.every(
    (agent) =>
      agent.effectivePolicy === common.effectivePolicy &&
      agent.policySource === common.policySource,
  );
  const effectiveSummary = uniform
    ? `${policyExplanation(common.effectivePolicy)} ${
        common.policySource === "local-override"
          ? "Set on this device."
          : common.policySource === "author"
            ? "Set by the author."
            : "The author did not specify a preference."
      }`
    : [
        entries
          .map((agent) => `${harnessLabel(agent.harness)}: ${policyLabel(agent.effectivePolicy)}`)
          .join("; "),
        ...(agents.opencode.effectivePolicy === "explicit"
          ? ["OpenCode V1 ignores this setting."]
          : []),
      ].join(". ");
  return {
    skill,
    agents,
    ...(overridePolicy === undefined ? {} : { overridePolicy }),
    storedIntent,
    question: `When can agents use ‘${skill}’?`,
    authorSummary: `Author preference: ${authorPreference({ agents })}`,
    effectiveSummary,
    ...(defects.size ? { defect: [...defects].join("\n") } : {}),
  };
}

export interface InvocationPolicyChoice {
  value: InvocationOption;
  label: string;
  hint?: string;
}

/** Name the four stored intents as decisions, including what following the author will mean. */
export function invocationPolicyChoices(model: InvocationReadModel): InvocationPolicyChoice[] {
  const preference = authorPreference(model);
  const options: InvocationPolicyChoice[] = [
    {
      value: "declared",
      label:
        preference === "Not specified"
          ? "Author preference — none (agent default)"
          : `Author preference — ${preference.toLowerCase()}`,
    },
    { value: "implicit", label: policyLabel("implicit") },
    { value: "explicit", label: policyLabel("explicit") },
    { value: "host-policy", label: policyLabel("host-policy") },
  ];
  return options.map((option) =>
    option.value === model.storedIntent ? { ...option, hint: "current" } : option,
  );
}

/** Explain author evidence, the local choice and resulting behavior before asking for a change. */
export function invocationBriefing(policy: InvocationReadModel): string {
  const summary = invocationRowSummary(policy);
  return [
    ...(policy.overridePolicy || summary === "Varies by agent" ? [policy.authorSummary] : []),
    `Current: ${summary}`,
    ...(summary === "Varies by agent" ? [policy.effectiveSummary] : []),
    ...(policy.defect ? ["", policy.defect] : []),
  ].join("\n");
}

export function invocationRowSummary(model: InvocationReadModel): string {
  const entries = agentEntries(model);
  const common = model.agents.codex;
  if (
    entries.some(
      (agent) =>
        agent.effectivePolicy !== common.effectivePolicy ||
        agent.policySource !== common.policySource,
    )
  )
    return "Varies by agent";
  if (common.policySource === "harness-default") return policyLabel(common.effectivePolicy);
  return `${policyLabel(common.effectivePolicy)} · ${common.policySource === "local-override" ? "you" : "author"}`;
}
