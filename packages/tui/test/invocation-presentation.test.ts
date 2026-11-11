import { expect, test } from "vitest";
import type { InvocationReadModel } from "@smolai/skit-core/library/session";
import {
  invocationBriefing,
  invocationPolicyChoices,
  scopeRowLabel,
} from "../src/library/invocation";

const agent = {
  authorPolicy: "unspecified",
  authorPolicySource: { kind: "unspecified" },
  authorDeclarations: [],
  conformance: { state: "conforming" },
  effectivePolicy: "host-policy",
  policySource: "harness-default",
} as const;

test("TUI owns policy choices and explains legacy conformance from the shared facts", () => {
  const policy: InvocationReadModel = {
    skill: "review",
    storedIntent: "declared",
    agents: {
      codex: agent,
      opencode: agent,
      devin: agent,
      "claude-code": {
        ...agent,
        conformance: {
          state: "unverified-legacy",
          path: "skills/review/SKILL.md",
          field: "disable-model-invocation",
        },
      },
    },
  };
  const before = JSON.stringify(policy);
  expect(invocationBriefing(policy)).toContain(
    "Claude Code: ‘review’ was published before skills carried this setting in their own metadata",
  );
  expect(invocationBriefing(policy)).toContain(
    "skills/review/SKILL.md states no disable-model-invocation",
  );
  expect(invocationPolicyChoices(policy)).toEqual([
    { value: "declared", label: "Author preference — none (harness default)", hint: "current" },
    { value: "implicit", label: "Automatically" },
    { value: "explicit", label: "Only when asked" },
    { value: "host-policy", label: "Harness default" },
  ]);
  expect(JSON.stringify(policy)).toBe(before);
});

test("a scope without readable policy evidence is described as unavailable", () => {
  expect(scopeRowLabel({ scope: { kind: "global" } })).toBe(
    "Everywhere on this device | Author preference unavailable",
  );
});
