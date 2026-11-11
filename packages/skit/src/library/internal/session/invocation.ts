// The structured account of invocation policy both front ends render: author declarations,
// the local override, and what installing will write. Pure: no filesystem, prompts or streams.
// Author evidence is per agent; a plain Skill can carry different policies in one shared copy.
import {
  DeclaredInvocation,
  DeclaredPolicySource,
  DeclaredInvocationResolution,
  InvocationConformance,
  ResolvedDeclaredPolicy,
} from "../../../invocation/conformance.js";
import { HarnessName } from "../../../harnesses/contracts.js";
import { InvocationPolicy } from "../../../artifact/invocation-policy.js";
import { invocationMetadataAdapters } from "../../../harnesses/invocation-metadata.js";
import { LibraryInvocationOption } from "../../invocation-option.js";
import { Record, Schema } from "effect";
import type { InvocationOption } from "./invocation-option.js";

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
});
export type InvocationReadModel = typeof InvocationReadModel.Type;

/** Match installing: an override or descriptor policy is written; otherwise native fields survive. */
export function invocationReadModel(input: {
  skill: string;
  author: AuthorInvocation;
  storedIntent: InvocationOption;
}): InvocationReadModel {
  const { skill, author, storedIntent } = input;
  const overridePolicy = storedIntent === "declared" ? undefined : storedIntent;
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
    return agent;
  });
  return {
    skill,
    agents,
    ...(overridePolicy === undefined ? {} : { overridePolicy }),
    storedIntent,
  };
}
