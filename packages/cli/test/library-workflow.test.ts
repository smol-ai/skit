import { Result } from "effect";
import { describe, expect, test } from "vitest";
import {
  eligibleHarnesses,
  invocationEligibleBindings,
  scopeChoices,
  scopeKey,
} from "../src/library/read-model.js";

describe("Library workflow choices", () => {
  test("keys a Scope by the destination it selects", () => {
    expect(scopeKey({ kind: "global" })).toBe("global");
    expect(scopeKey({ kind: "repository", root: "/repo" })).toBe("repository:/repo");
  });

  test("offers global and repository choices carrying their Scope values", () => {
    const choices = scopeChoices("/work");
    expect(choices.map((choice) => choice.value)).toEqual(["global", "repository"]);
    expect(choices[0].scope).toEqual({ kind: "global" });
    expect(choices[1].scope).toEqual({ kind: "repository", root: "/work" });
  });

  test("an explicit Harness request wins over detection", () => {
    expect(
      Result.getOrThrow(
        eligibleHarnesses({ detected: ["codex", "claude-code"], requested: "codex" }),
      ),
    ).toEqual(["codex"]);
    expect(Result.getOrThrow(eligibleHarnesses({ detected: ["codex", "claude-code"] }))).toEqual([
      "codex",
      "claude-code",
    ]);
  });

  test("no candidate Harness is a named failure", () => {
    const outcome = eligibleHarnesses({ detected: [] });
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome))
      expect(outcome.failure).toMatchObject({ _tag: "NoSupportedHarnesses", code: "NOT_FOUND" });
  });

  test("finds only Bindings whose Harness carries invocation policy", () => {
    const row = {
      bindings: [
        { harness: "codex" as const, scope: { kind: "global" as const } },
        { harness: "devin" as const, scope: { kind: "global" as const } },
        { harness: "opencode" as const, scope: { kind: "global" as const } },
      ],
    };
    expect(invocationEligibleBindings(row).map((binding) => binding.harness)).toEqual([
      "codex",
      "devin",
      "opencode",
    ]);
  });
});
