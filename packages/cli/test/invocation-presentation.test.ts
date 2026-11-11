import { expect, test } from "vitest";
import type { InvocationReadModel } from "@smolai/skit-core/library/session";
import { Block } from "../src/terminal/blocks.js";
import {
  invocationBriefing,
  invocationExplanation,
  invocationPolicyChoices,
} from "../src/library/presentation/invocation.js";

const defaultAgent = {
  authorPolicy: "unspecified",
  authorPolicySource: { kind: "unspecified" },
  authorDeclarations: [],
  conformance: { state: "conforming" },
  effectivePolicy: "host-policy",
  policySource: "harness-default",
} as const;
const base: InvocationReadModel = {
  skill: "review",
  storedIntent: "declared",
  agents: {
    codex: defaultAgent,
    "claude-code": defaultAgent,
    opencode: defaultAgent,
    devin: defaultAgent,
  },
};

test("a contradiction is explained in semantic blocks without changing the available intents", () => {
  const policy: InvocationReadModel = {
    ...base,
    agents: {
      ...base.agents,
      "claude-code": {
        ...defaultAgent,
        effectivePolicy: "explicit",
        policySource: "author",
        conformance: {
          state: "non-conforming",
          declared: "explicit",
          native: "implicit",
          path: "skills/review/SKILL.md",
          field: "disable-model-invocation",
        },
      },
    },
  };
  const before = JSON.stringify(policy);
  expect(invocationBriefing(policy)).toContainEqual(
    Block.Group({
      title: "Claude Code",
      children: [
        Block.Note({
          text: [
            { code: "review" },
            " contradicts itself: its author declared ",
            "only when asked",
            ", but the published metadata in ",
            { path: "skills/review/SKILL.md" },
            " sets ",
            { code: "disable-model-invocation" },
            " to ",
            "automatically",
            ". Only the author can repair this.",
          ],
        }),
      ],
    }),
  );
  const choices = invocationPolicyChoices(policy);
  expect(choices.map((choice) => choice.value)).toEqual([
    "declared",
    "implicit",
    "explicit",
    "host-policy",
  ]);
  expect(
    choices.filter((choice) => choice.hint === "current").map((choice) => choice.value),
  ).toEqual(["declared"]);
  expect(JSON.stringify(policy)).toBe(before);
});

test("the frontend explains the OpenCode limit and names unspecified author policy from facts", () => {
  const explicit = {
    ...defaultAgent,
    effectivePolicy: "explicit",
    policySource: "local-override",
  } as const;
  const policy: InvocationReadModel = {
    ...base,
    storedIntent: "explicit",
    overridePolicy: "explicit",
    agents: { codex: explicit, "claude-code": explicit, opencode: explicit, devin: explicit },
  };
  expect(invocationExplanation(policy)).toBe(
    "Agents use this skill only when you ask for it. OpenCode V1 ignores this setting. Set on this device.",
  );
  expect(invocationPolicyChoices(policy)[0]).toEqual({
    value: "declared",
    label: "Author preference — none (harness default)",
  });
  expect(invocationBriefing(policy)).toContainEqual(
    Block.Fields({
      rows: [
        { label: "Author preference", value: ["Not specified"] },
        { label: "Current", value: ["Only when asked | you"] },
      ],
    }),
  );
});
