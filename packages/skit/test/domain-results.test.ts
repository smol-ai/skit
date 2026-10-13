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
      const outcome = claude.write("---\n: :\n---\nBody\n", "explicit", "SKILL.md");
      assert.strictEqual(tagOf(outcome), "HarnessMetadataInvalid");
    }),
  );

  it.effect("names unparseable Codex metadata instead of throwing", () =>
    Effect.sync(() => {
      const outcome = codex.write("policy: [unclosed", "implicit", "agents/openai.yaml");
      assert.strictEqual(tagOf(outcome), "HarnessMetadataInvalid");
    }),
  );

  it.effect("still writes a well-formed document", () =>
    Effect.sync(() => {
      const outcome = claude.write("---\nname: review\n---\nBody\n", "explicit", "SKILL.md");
      assert.strictEqual(tagOf(outcome), "Success");
      if (Result.isSuccess(outcome))
        assert.include(String(outcome.success), "disable-model-invocation: true");
    }),
  );

  it.effect("maps Devin invocation policy and preserves host-policy metadata", () =>
    Effect.sync(() => {
      const authored = "---\nname: review\ntriggers: [user, custom]\n---\nBody\n";
      const explicit = devin.write(authored, "explicit", "SKILL.md");
      const implicit = devin.write(authored, "implicit", "SKILL.md");
      const hostPolicy = devin.write(authored, "host-policy", "SKILL.md");
      const defaultHostPolicy = devin.write(
        "---\nname: review\n---\nBody\n",
        "host-policy",
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

describe("Codex invocation metadata reads", () => {
  const codex = invocationMetadataAdapters.codex;
  const read = (text: string) => codex.read(text, "agents/openai.yaml");

  it.effect("resolves an aliased value and an aliased policy mapping", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        read("disabled: &off false\npolicy:\n  allow_implicit_invocation: *off\n"),
        Result.succeed("explicit"),
      );
      assert.deepStrictEqual(
        read("shared: &policy {allow_implicit_invocation: false}\npolicy: *policy\n"),
        Result.succeed("explicit"),
      );
    }),
  );

  it.effect("treats a present value that is not a boolean as invalid, not absent", () =>
    Effect.sync(() => {
      for (const text of [
        "policy: {allow_implicit_invocation: no-policy}\n",
        'policy: {allow_implicit_invocation: "false"}\n',
        "policy: {allow_implicit_invocation: null}\n",
        "policy: [allow_implicit_invocation]\n",
        "policy: implicit\n",
      ])
        assert.strictEqual(tagOf(read(text)), "HarnessMetadataInvalid", text);
      assert.deepStrictEqual(
        read("interface: {display_name: Review}\n"),
        Result.succeed(undefined),
      );
      assert.deepStrictEqual(read(""), Result.succeed(undefined));
    }),
  );

  it.effect("reads the field without expanding unrelated aliases", () =>
    Effect.sync(() => {
      const bomb = [
        "a: &a [1,2,3,4,5,6,7,8,9,10]",
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
        "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
        "d: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]",
        "policy: {allow_implicit_invocation: false}",
      ].join("\n");
      assert.deepStrictEqual(read(bomb), Result.succeed("explicit"));
    }),
  );

  it.effect("refuses to rewrite invalid metadata or an aliased policy mapping", () =>
    Effect.sync(() => {
      for (const text of [
        "policy: {allow_implicit_invocation: no-policy}\n",
        "shared: &policy {allow_implicit_invocation: false}\npolicy: *policy\n",
      ])
        for (const policy of ["implicit", "host-policy"] as const)
          assert.strictEqual(
            tagOf(codex.write(text, policy, "agents/openai.yaml")),
            "HarnessMetadataInvalid",
          );
    }),
  );
});
