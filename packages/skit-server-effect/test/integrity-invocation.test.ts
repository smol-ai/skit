import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  assessInvocationConformance,
  describeInvocationConformanceIssue,
} from "../src/integrity/invocation.js";

const skill = { name: "review", path: "skills/review", invocation: "explicit" as const };

describe("Integrity invocation conformance", () => {
  it.effect("reports both authored harness declarations when metadata is absent", () =>
    Effect.gen(function* () {
      const issues = yield* assessInvocationConformance([skill], () => undefined);

      expect(issues).toEqual([
        expect.objectContaining({
          harness: "codex",
          path: "skills/review/agents/openai.yaml",
          expected: false,
          actual: undefined,
        }),
      ]);
    }),
  );

  it.effect("accepts matching Claude and Codex metadata", () =>
    Effect.gen(function* () {
      const files = new Map([
        [
          "skills/review/SKILL.md",
          "---\nname: review\ndisable-model-invocation: true\n---\n# Review\n",
        ],
        ["skills/review/agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n"],
      ]);

      expect(yield* assessInvocationConformance([skill], (path) => files.get(path))).toEqual([]);
    }),
  );

  it.effect("requires host-policy metadata fields to be absent", () =>
    Effect.gen(function* () {
      const issues = yield* assessInvocationConformance(
        [{ ...skill, invocation: "host-policy" }],
        (path) =>
          path.endsWith("SKILL.md")
            ? "---\ndisable-model-invocation: true\n---\n"
            : "policy:\n  allow_implicit_invocation: false\n",
      );

      expect(issues).toHaveLength(2);
      expect(describeInvocationConformanceIssue(issues[0])).toContain("skit author invocation");
    }),
  );

  it.effect("fails malformed native metadata on the typed channel", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(assessInvocationConformance([skill], () => "policy: ["));

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure.code).toBe("INVALID_INVOCATION_METADATA");
    }),
  );
});
