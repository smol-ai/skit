import { describe, expect, test } from "vitest";
import { invocationEligibleBindings, scopeChoices, scopeKey } from "../src/library/read-model.js";

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

  test("finds only Bindings that carry an invocation policy", () => {
    const policy = {} as NonNullable<
      Parameters<typeof invocationEligibleBindings>[0]["bindings"][number]["policy"]
    >;
    const row = {
      bindings: [
        { scope: { kind: "global" as const }, policy },
        { scope: { kind: "repository" as const, root: "/repo" } },
      ],
    };
    expect(invocationEligibleBindings(row).map((binding) => binding.scope.kind)).toEqual([
      "global",
    ]);
  });
});
