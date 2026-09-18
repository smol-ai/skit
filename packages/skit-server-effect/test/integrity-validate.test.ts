import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { sha256 } from "../src/integrity/crypto.js";
import { validateArtifactBundle } from "../src/integrity/validate.js";

const file = Effect.fn("Test.file")(function* (path: string, contents: string) {
  const bytes = new TextEncoder().encode(contents);
  return {
    path,
    bytes,
    digest: yield* sha256(bytes),
    media_type: "text/plain",
    executable: false,
  };
});

const validBundle = Effect.gen(function* () {
  const descriptor = {
    skit: 1 as const,
    id: "alice/tools",
    slug: "tools",
    sameAs: ["https://example.com/alice/tools"],
    author: { name: "Alice", sameAs: ["https://example.com/alice"] },
    skills: [
      {
        name: "review",
        path: "skills/review",
        default_enabled: true,
        invocation: "explicit" as const,
      },
    ],
  };
  const files = [
    yield* file(
      "skit.json",
      JSON.stringify({
        slug: "tools",
        sameAs: ["https://example.com/alice/tools"],
        author: { name: "Alice", sameAs: ["https://example.com/alice"] },
        skills: [
          {
            name: "review",
            path: "skills/review",
            default_enabled: true,
            trigger_modes: ["explicit"],
          },
        ],
      }),
    ),
    yield* file(
      "skills/review/SKILL.md",
      "---\nname: review\ndisable-model-invocation: true\n---\n# Review\n",
    ),
    yield* file(
      "skills/review/agents/openai.yaml",
      "policy:\n  allow_implicit_invocation: false\n",
    ),
  ];
  return { descriptor, files };
});

describe("Integrity draft validation", () => {
  it.effect("accepts a complete conforming draft", () =>
    Effect.gen(function* () {
      const bundle = yield* validBundle;
      const validated = yield* validateArtifactBundle(
        "alice",
        "tools",
        bundle.descriptor,
        bundle.files,
      );

      expect(validated.descriptor.id).toBe("alice/tools");
      expect(validated.diagnostics).toEqual([]);
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  it.effect("rejects descriptor payload drift", () =>
    Effect.gen(function* () {
      const bundle = yield* validBundle;
      const outcome = yield* Effect.result(
        validateArtifactBundle(
          "alice",
          "tools",
          { ...bundle.descriptor, slug: "other" },
          bundle.files,
        ),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure" && outcome.failure._tag === "Integrity.Error")
        expect(outcome.failure.code).toBe("DESCRIPTOR_CONTENT_MISMATCH");
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  it.effect(
    "returns publication diagnostics for invocation drift and unsafe undeclared behavior",
    () =>
      Effect.gen(function* () {
        const bundle = yield* validBundle;
        const files = bundle.files.filter(
          ({ path }) => path !== "skills/review/agents/openai.yaml",
        );
        const skillIndex = files.findIndex(({ path }) => path === "skills/review/SKILL.md");
        files[skillIndex] = yield* file(
          "skills/review/SKILL.md",
          "---\nname: review\ndisable-model-invocation: false\n---\nRun `git push`.\n",
        );
        const validated = yield* validateArtifactBundle("alice", "tools", bundle.descriptor, files);

        expect(validated.diagnostics.map(({ code }) => code)).toEqual([
          "SECURITY_POLICY_BLOCKED",
          "INVOCATION_METADATA_MISMATCH",
          "INVOCATION_METADATA_MISMATCH",
        ]);
      }).pipe(Effect.provide(BrowserCrypto.layer)),
  );
});
