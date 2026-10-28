import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { sha256Hash } from "@smolai/skit-core/universal/consumer";
import { validateArtifactBundle } from "../src/integrity/validate.js";

const file = Effect.fn("Test.file")(function* (path: string, contents: string) {
  const bytes = new TextEncoder().encode(contents);
  return {
    path,
    bytes,
    digest: yield* sha256Hash(bytes),
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

/** Skills that each map one 1 MiB shared file `mappings` times, a valid layout that multiplies. */
const sharedBundle = Effect.fn("Test.sharedBundle")(function* (skills: number, mappings: number) {
  const declared = Array.from({ length: skills }, (_, index) => ({
    name: `skill-${index}`,
    path: `skills/skill-${index}`,
    default_enabled: true,
    shared: Array.from({ length: mappings }, (_, copy) => ({
      from: "shared/reference.bin",
      to: `references/copy-${copy}.bin`,
    })),
  }));
  const files = [
    yield* file("skit.json", JSON.stringify({ slug: "tools", skills: declared })),
    yield* file("shared/reference.bin", "x".repeat(1024 * 1024)),
    ...(yield* Effect.forEach(declared, (skill) =>
      file(`${skill.path}/SKILL.md`, `---\nname: ${skill.name}\n---\n# Shared\n`),
    )),
  ];
  return {
    descriptor: { skit: 1 as const, id: "alice/tools", slug: "tools", skills: declared },
    files,
  };
});

/** Skills that each map one directory of nine empty files `mappings` times: 1 + 9 × mappings entries. */
const emptyDirectoryBundle = Effect.fn("Test.emptyDirectoryBundle")(function* (
  skills: number,
  mappings: number,
) {
  const declared = Array.from({ length: skills }, (_, index) => ({
    name: `skill-${index}`,
    path: `skills/skill-${index}`,
    default_enabled: true,
    shared: Array.from({ length: mappings }, (_, copy) => ({
      from: "shared/empty",
      to: `references/copy-${copy}`,
    })),
  }));
  const files = [
    yield* file("skit.json", JSON.stringify({ slug: "tools", skills: declared })),
    ...(yield* Effect.forEach(
      Array.from({ length: 9 }, (_, index) => index),
      (index) => file(`shared/empty/file-${index}.md`, ""),
    )),
    ...(yield* Effect.forEach(declared, (skill) =>
      file(`${skill.path}/SKILL.md`, `---\nname: ${skill.name}\n---\n# Shared\n`),
    )),
  ];
  return {
    descriptor: { skit: 1 as const, id: "alice/tools", slug: "tools", skills: declared },
    files,
  };
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

  it.effect("translates conflicting invocation declarations at the Worker boundary", () =>
    Effect.gen(function* () {
      const config = yield* file(
        "skit.json",
        JSON.stringify({
          slug: "tools",
          skills: [
            {
              name: "review",
              path: "skills/review",
              invocation: "explicit",
              trigger_modes: ["implicit"],
            },
          ],
        }),
      );
      const failure = yield* Effect.flip(validateArtifactBundle("alice", "tools", {}, [config]));
      expect(failure).toMatchObject({
        _tag: "Integrity.Error",
        code: "CONFLICTING_INVOCATION_DECLARATIONS",
      });
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

  it.effect("rejects malformed native invocation metadata", () =>
    Effect.gen(function* () {
      const bundle = yield* validBundle;
      const files = [...bundle.files];
      const codexIndex = files.findIndex(({ path }) => path === "skills/review/agents/openai.yaml");
      files[codexIndex] = yield* file("skills/review/agents/openai.yaml", "policy: [");
      const outcome = yield* Effect.result(
        validateArtifactBundle("alice", "tools", bundle.descriptor, files),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure" && outcome.failure._tag === "Integrity.Error")
        expect(outcome.failure).toMatchObject({
          code: "INVALID_INVOCATION_METADATA",
          detail: "skills/review/agents/openai.yaml",
        });
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  for (const [label, skills, mappings, code] of [
    ["one Skill projects more than 8 MiB", 1, 9, "PROJECTED_SKILL_TOO_LARGE"],
    ["its Skills together project more than 32 MiB", 5, 7, "PROJECTED_RELEASE_TOO_LARGE"],
  ] as const)
    it.effect(`rejects a draft when ${label}`, () =>
      Effect.gen(function* () {
        const bundle = yield* sharedBundle(skills, mappings);
        const outcome = yield* Effect.result(
          validateArtifactBundle("alice", "tools", bundle.descriptor, bundle.files),
        );

        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") expect(outcome.failure).toMatchObject({ code });
      }).pipe(Effect.provide(BrowserCrypto.layer)),
    );

  it.effect("accepts Skills sharing one file within the projection limits", () =>
    Effect.gen(function* () {
      const bundle = yield* sharedBundle(4, 7);
      const outcome = yield* Effect.result(
        validateArtifactBundle("alice", "tools", bundle.descriptor, bundle.files),
      );

      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  // Empty files cost no content but still cost archive entries.
  for (const [label, skills, mappings, code] of [
    ["one Skill projects 1,000 entries", 1, 111, undefined],
    ["one Skill projects more than 1,000 entries", 1, 112, "PROJECTED_SKILL_TOO_LARGE"],
    ["its Skills together project 10,000 entries", 10, 111, undefined],
    [
      "its Skills together project more than 10,000 entries",
      11,
      111,
      "PROJECTED_RELEASE_TOO_LARGE",
    ],
  ] as const)
    it.effect(`${code ? "rejects" : "accepts"} a draft when ${label}`, () =>
      Effect.gen(function* () {
        const bundle = yield* emptyDirectoryBundle(skills, mappings);
        const outcome = yield* Effect.result(
          validateArtifactBundle("alice", "tools", bundle.descriptor, bundle.files),
        );

        if (code === undefined) expect(outcome._tag).toBe("Success");
        else {
          expect(outcome._tag).toBe("Failure");
          if (outcome._tag === "Failure") expect(outcome.failure).toMatchObject({ code });
        }
      }).pipe(Effect.provide(BrowserCrypto.layer)),
    );
});
