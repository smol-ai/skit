import { Record } from "effect";
import { Block, type Inline } from "../../terminal/blocks.js";
import type {
  InvocationReadModel,
  InvocationOption,
  InstallScope,
  PendingLibraryChange,
  ScopeChoice,
} from "@smolai/skit-core/library/session";
import { HarnessName, harnessLabel } from "@smolai/skit-core/harnesses";
type InvocationPolicy = InvocationReadModel["agents"]["codex"]["effectivePolicy"];
type ResolvedDeclaredPolicy = InvocationReadModel["agents"]["codex"]["authorPolicy"];
type InvocationConformance = InvocationReadModel["agents"]["codex"]["conformance"];
interface InvocationScopeRow {
  readonly scope: InstallScope;
  readonly policy?: InvocationReadModel;
}
const policyLabels = {
  implicit: "Automatically",
  explicit: "Only when asked",
  "host-policy": "Harness default",
} satisfies Record<InvocationPolicy, string>;
const policyExplanations = {
  implicit: "Agents may choose this skill on their own when it fits.",
  explicit: "Agents use this skill only when you ask for it. OpenCode V1 ignores this setting.",
  "host-policy": "Each agent decides, using its own default.",
} satisfies Record<InvocationPolicy, string>;
const policyLabel = (policy: InvocationPolicy): string => policyLabels[policy];
const policyExplanation = (policy: InvocationPolicy): string => policyExplanations[policy];

function authorPolicyLabel(policy: ResolvedDeclaredPolicy): string {
  return policy === "unspecified" ? "Not specified" : policyLabel(policy);
}

export function destinationLabel(scope: InstallScope): string {
  return scope.kind === "global" ? "Everywhere on this device" : scope.root;
}

function conformanceBlocks(conformance: InvocationConformance, skill: string): readonly Block[] {
  switch (conformance.state) {
    case "conforming":
      return [];
    case "non-conforming":
      return [
        Block.Note({
          text: [
            { code: skill },
            " contradicts itself: its author declared ",
            policyLabel(conformance.declared).toLowerCase(),
            ", but the published metadata in ",
            { path: conformance.path },
            " sets ",
            { code: conformance.field },
            " to ",
            policyLabel(conformance.native).toLowerCase(),
            ". Only the author can repair this.",
          ],
        }),
      ];
    case "unverified-legacy":
      return [
        Block.Note({
          text: [
            { code: skill },
            " was published before skills carried this setting in their own metadata: ",
            { path: conformance.path },
            " states no ",
            { code: conformance.field },
            ", so its compatibility outside SKIT is unverified.",
          ],
        }),
      ];
  }
  return conformance satisfies never;
}

const agentEntries = (model: Pick<InvocationReadModel, "agents">) =>
  HarnessName.literals.map((harness) => ({ harness, ...model.agents[harness] }));

const authorPreference = (model: Pick<InvocationReadModel, "agents">): string => {
  const policy = model.agents.codex.authorPolicy;
  return agentEntries(model).every((agent) => agent.authorPolicy === policy)
    ? authorPolicyLabel(policy)
    : "Varies by agent";
};

export interface InvocationPolicyChoice {
  value: InvocationOption;
  label: string;
  hint?: string;
}

/** Name the four stored intents as decisions, including what following the author will mean. */
export function invocationPolicyChoices(model: InvocationReadModel): InvocationPolicyChoice[] {
  const preference = authorPreference(model);
  const labels = {
    declared: agentEntries(model).every((agent) => agent.authorPolicy === "unspecified")
      ? "Author preference — none (harness default)"
      : `Author preference — ${preference.toLowerCase()}`,
    implicit: policyLabel("implicit"),
    explicit: policyLabel("explicit"),
    "host-policy": policyLabel("host-policy"),
  } satisfies Record<InvocationOption, string>;
  return Record.keys(labels).map((value) => ({
    value,
    label: labels[value],
    ...(value === model.storedIntent ? { hint: "current" } : {}),
  }));
}

/** Explain author evidence, the local choice and resulting behavior before asking for a change. */
export function invocationBriefing(policy: InvocationReadModel): readonly Block[] {
  const summary = invocationRowSummary(policy);
  return [
    Block.Fields({
      rows: [
        ...(policy.overridePolicy || invocationVaries(policy)
          ? [{ label: "Author preference", value: [authorPreference(policy)] }]
          : []),
        { label: "Current", value: [summary] },
        ...(invocationVaries(policy)
          ? [{ label: "Meaning", value: [invocationExplanation(policy)] }]
          : []),
      ],
    }),
    ...agentEntries(policy).flatMap((agent) => {
      const children = conformanceBlocks(agent.conformance, policy.skill);
      return children.length ? [Block.Group({ title: harnessLabel(agent.harness), children })] : [];
    }),
  ];
}

export function invocationRowSummary(model: InvocationReadModel): string {
  const common = model.agents.codex;
  if (invocationVaries(model)) return "Varies by agent";
  if (common.policySource === "harness-default") return policyLabel(common.effectivePolicy);
  return `${policyLabel(common.effectivePolicy)} | ${common.policySource === "local-override" ? "you" : "author"}`;
}

export const DESTINATION_QUESTION = "Where should this change apply?";
export const scopeChoiceLabels = {
  global: "Everywhere on this device",
  repository: "Only this repository",
} satisfies Record<ScopeChoice["value"], string>;
export const fileChangeLabels = {
  install: "install skill files",
  uninstall: "remove installed skill files",
  unchanged: "nothing to change",
  "check-for-repair": "copies checked for repair",
} satisfies Record<PendingLibraryChange["facts"][number]["fileChange"], string>;
export function scopeRowLabel(row: InvocationScopeRow): string {
  return `${destinationLabel(row.scope)} | ${row.policy ? invocationRowSummary(row.policy) : "Author preference unavailable"}`;
}
export function invocationChoices(row: InvocationScopeRow): InvocationPolicyChoice[] {
  return row.policy ? invocationPolicyChoices(row.policy) : [];
}
export function invocationQuestion(model: InvocationReadModel): string {
  return `When can agents use ‘${model.skill}’?`;
}
export function invocationExplanation(model: InvocationReadModel): string {
  const agents = model.agents;
  const entries = agentEntries(model);
  const common = agents.codex;
  const uniform = entries.every(
    (agent) =>
      agent.effectivePolicy === common.effectivePolicy &&
      agent.policySource === common.policySource,
  );
  return uniform
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
}

function invocationVaries(model: InvocationReadModel): boolean {
  const common = model.agents.codex;
  return agentEntries(model).some(
    (agent) =>
      agent.effectivePolicy !== common.effectivePolicy ||
      agent.policySource !== common.policySource,
  );
}

export const destinationValue = (scope: InstallScope): readonly Inline[] =>
  scope.kind === "global" ? ["Everywhere on this device"] : [{ path: scope.root }];
