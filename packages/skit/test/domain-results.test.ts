// Core domain decisions arrive as data, not as thrown exceptions lifted by an allow-list.
//
// Each of these was an Effect.try wrapping one of our own pure functions, catching unknown and
// testing identity. Nothing made those lists exhaustive: dropping a name still compiled while an
// expected failure became a defect with the wrong exit code.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { invocationMetadataAdapters } from "../src/harnesses/invocation-metadata.js";

const tagOf = (outcome: Result.Result<unknown, unknown>): string =>
  Result.isFailure(outcome) ? String((outcome.failure as { _tag?: string })._tag) : "Success";

describe("invocation metadata writes", () => {
  const claude = invocationMetadataAdapters["claude-code"];
  const codex = invocationMetadataAdapters.codex;
  const devin = invocationMetadataAdapters.devin;

  it.effect("names unparseable frontmatter instead of throwing", () =>
    Effect.sync(() => {
      const outcome = claude.write("---\n: :\n---\nBody\n", true, "SKILL.md");
      assert.strictEqual(tagOf(outcome), "HarnessMetadataInvalid");
    }),
  );

  it.effect("names unparseable Codex metadata instead of throwing", () =>
    Effect.sync(() => {
      const outcome = codex.write("policy: [unclosed", true, "agents/openai.yaml");
      assert.strictEqual(tagOf(outcome), "HarnessMetadataInvalid");
    }),
  );

  it.effect("still writes a well-formed document", () =>
    Effect.sync(() => {
      const outcome = claude.write("---\nname: review\n---\nBody\n", true, "SKILL.md");
      assert.strictEqual(tagOf(outcome), "Success");
      if (Result.isSuccess(outcome))
        assert.include(String(outcome.success), "disable-model-invocation: true");
    }),
  );

  it.effect("maps Devin invocation policy and preserves host-policy metadata", () =>
    Effect.sync(() => {
      const authored = "---\nname: review\ntriggers: [user, custom]\n---\nBody\n";
      const explicit = devin.write(authored, false, "SKILL.md");
      const implicit = devin.write(authored, true, "SKILL.md");
      const hostPolicy = devin.write(authored, undefined, "SKILL.md");
      const defaultHostPolicy = devin.write(
        "---\nname: review\n---\nBody\n",
        undefined,
        "SKILL.md",
      );
      assert.isTrue(Result.isSuccess(explicit));
      assert.isTrue(Result.isSuccess(implicit));
      assert.isTrue(Result.isSuccess(hostPolicy));
      assert.isTrue(Result.isSuccess(defaultHostPolicy));
      if (Result.isSuccess(explicit)) assert.include(explicit.success, "triggers: [ user ]");
      if (Result.isSuccess(implicit)) assert.include(implicit.success, "triggers: [ user, model ]");
      if (Result.isSuccess(hostPolicy)) assert.strictEqual(hostPolicy.success, authored);
      if (Result.isSuccess(defaultHostPolicy))
        assert.notInclude(defaultHostPolicy.success, "triggers");
    }),
  );
});
