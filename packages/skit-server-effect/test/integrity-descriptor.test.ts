import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { skitDescriptorRequestSchema } from "@smolai/skit-core/universal/authoring";
import { hashProjectedSkillFiles } from "../src/integrity/descriptor.js";

describe("Integrity descriptor", () => {
  it.effect("pins the legacy depth-first code-unit Skill digest", () =>
    Effect.gen(function* () {
      const files = [
        ["a.md", "A"],
        ["a/b.md", "B"],
        ["z.md", "Z"],
        ["ä.md", "U"],
      ].map(([path, contents]) => ({
        path: `skills/review/${path}`,
        bytes: new TextEncoder().encode(contents),
      }));

      expect(yield* hashProjectedSkillFiles(files, "skills/review")).toBe(
        "sha256:8e60154df4bbfb3eb6cc8ae833518f4c6ef1c82df527ba6b00260fdfec995ad1",
      );
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  it.effect("translates shared target collisions at the Worker boundary", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        hashProjectedSkillFiles(
          [
            { path: "skills/review/SKILL.md", bytes: new Uint8Array() },
            { path: "shared/SKILL.md", bytes: new Uint8Array() },
          ],
          "skills/review",
          [{ from: "shared/SKILL.md", to: "SKILL.md" }],
        ),
      );
      expect(failure).toMatchObject({
        _tag: "Integrity.Error",
        code: "SHARED_MAPPING_COLLISION",
      });
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  it.effect("preserves extended Descriptor fields through stored JSON", () =>
    Effect.gen(function* () {
      const descriptor = {
        skit: 1 as const,
        id: "alice/tools",
        slug: "tools",
        skills: [
          {
            name: "review",
            path: "skills/review",
            default_enabled: true,
            invocation: "explicit",
            capabilities: ["filesystem_read"],
          },
        ],
        capabilities: { executables: ["bin/review"] },
      };
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(skitDescriptorRequestSchema),
      )(JSON.stringify(descriptor));
      expect(decoded).toEqual(descriptor);
    }),
  );
});
