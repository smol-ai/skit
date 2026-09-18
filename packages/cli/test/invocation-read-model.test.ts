import { resolveDeclaredInvocation } from "@smolai/skit-core";
import { describe, expect, test } from "vitest";
import { Result } from "effect";
import {
  invocationPolicyChoices,
  invocationReadModel,
  type InvocationHarness,
} from "../src/invocation/read-model.js";
import type { InvocationOption } from "../src/invocation/policy.js";

const CLAUDE = "skills/review/SKILL.md";

function model(options: {
  harness?: InvocationHarness;
  invocation?: "explicit" | "implicit" | "host-policy";
  files?: Record<string, string>;
  storedIntent?: InvocationOption;
}) {
  const harness = options.harness ?? "claude-code";
  const author = Result.getOrThrow(
    resolveDeclaredInvocation(
      {
        name: "review",
        path: "skills/review",
        ...(options.invocation ? { invocation: options.invocation } : {}),
      },
      (path) => options.files?.[path],
    ),
  );
  return invocationReadModel({
    skill: "review",
    harness,
    author: author[harness],
    storedIntent: options.storedIntent ?? "declared",
  });
}

describe("invocation read model", () => {
  test("an author default becomes the effective policy", () => {
    const resolved = model({ invocation: "explicit" });

    expect(resolved.authorPolicy).toBe("explicit");
    expect(resolved.authorPolicySource).toEqual({ kind: "skit-declaration" });
    expect(resolved.effectivePolicy).toBe("explicit");
    expect(resolved.policySource).toBe("author");
  });

  test("a local override wins and is named as the operator's own setting", () => {
    const resolved = model({ invocation: "implicit", storedIntent: "explicit" });

    expect(resolved.authorPolicy).toBe("implicit");
    expect(resolved.overridePolicy).toBe("explicit");
    expect(resolved.effectivePolicy).toBe("explicit");
    expect(resolved.policySource).toBe("local-override");
  });

  test("OpenCode explicit policy warns that V1 cannot enforce it", () => {
    const resolved = model({ harness: "opencode", storedIntent: "explicit" });

    expect(resolved.effectiveSummary).toContain("OpenCode V2");
    expect(resolved.effectiveSummary).toContain("OpenCode V1 ignores this setting");
  });

  test("an unspecified author policy defers visibly to the Harness", () => {
    const resolved = model({ harness: "codex" });

    expect(resolved.effectivePolicy).toBe("host-policy");
    expect(resolved.policySource).toBe("harness-default");
  });

  test("native metadata supplies the author default where no declaration exists", () => {
    const resolved = model({
      files: { [CLAUDE]: "---\nname: review\ndisable-model-invocation: true\n---\n" },
    });

    expect(resolved.authorPolicy).toBe("explicit");
    expect(resolved.authorPolicySource).toEqual({
      kind: "native-metadata",
      path: CLAUDE,
      field: "disable-model-invocation",
    });
    expect(resolved.effectivePolicy).toBe("explicit");
  });

  test("a contradiction is reported as a defect naming the file and field", () => {
    const resolved = model({
      invocation: "explicit",
      files: { [CLAUDE]: "---\nname: review\ndisable-model-invocation: false\n---\n" },
    });

    expect(resolved.defect).toBeDefined();
    expect(resolved.conformance.state).toBe("non-conforming");
    // The declaration still governs; the contradiction is reported, never offered as a choice.
    expect(resolved.effectivePolicy).toBe("explicit");
    expect(invocationPolicyChoices(resolved).map((choice) => choice.value)).toEqual([
      "declared",
      "implicit",
      "explicit",
      "host-policy",
    ]);
  });

  test("legacy authored metadata carries an unverified conformance defect", () => {
    const resolved = model({
      invocation: "explicit",
      files: { [CLAUDE]: "---\nname: review\n---\n" },
    });

    expect(resolved.conformance).toEqual({
      state: "unverified-legacy",
      path: CLAUDE,
      field: "disable-model-invocation",
    });
    expect(resolved.defect).toBeDefined();
  });

  test("the stored intents themselves are untouched by presentation", () => {
    // Presentation renames what the operator reads; the persisted enum stays the persisted enum.
    expect(invocationPolicyChoices(model({})).map((choice) => choice.value)).toEqual([
      "declared",
      "implicit",
      "explicit",
      "host-policy",
    ]);
    expect(model({ storedIntent: "explicit" }).storedIntent).toBe("explicit");
  });
});
