import { parseSkitConfig } from "@smolai/skit-core/universal/consumer";
import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { skitDescriptorRequestSchema } from "@smolai/skit-core/universal/authoring";
import {
  hashInstalledSkillFiles,
  descriptorError,
} from "../src/skits/internal/integrity/descriptor.js";

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

      expect(yield* hashInstalledSkillFiles(files, "skills/review")).toBe(
        "sha256:8e60154df4bbfb3eb6cc8ae833518f4c6ef1c82df527ba6b00260fdfec995ad1",
      );
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  it.effect("translates shared target collisions at the Worker boundary", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        hashInstalledSkillFiles(
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
        detail: "Shared target collision: SKILL.md",
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
      const decoded = yield* Schema.decodeEffect(
        Schema.fromJsonString(skitDescriptorRequestSchema),
      )(JSON.stringify(descriptor));
      expect(decoded).toEqual(descriptor);
    }),
  );
});

it.effect("descriptor failures get server-owned details without losing the transport code", () =>
  Effect.gen(function* () {
    const malformed = descriptorError(yield* Effect.flip(parseSkitConfig("{")));
    expect(malformed.code).toBe("INVALID_DESCRIPTOR");
    expect(malformed.detail).toContain("Malformed JSON SKIT Descriptor:");
    const conflict = descriptorError(
      yield* Effect.flip(
        parseSkitConfig(
          JSON.stringify({
            slug: "tools",
            skills: [
              {
                name: "review",
                path: "review",
                invocation: "explicit",
                trigger_modes: ["implicit"],
              },
            ],
          }),
        ),
      ),
    );
    expect(conflict).toMatchObject({
      code: "CONFLICTING_INVOCATION_DECLARATIONS",
      detail: "review declares conflicting invocation and trigger_modes values",
    });
  }),
);

it.effect("descriptor constraints acquire server wording after parsing structured failures", () =>
  Effect.gen(function* () {
    const cause = yield* Effect.flip(
      parseSkitConfig(
        JSON.stringify({ slug: "tools", skills: [{ name: "review", path: "../escape" }] }),
      ),
    );
    const failure = descriptorError(cause);
    expect(failure).toMatchObject({ code: "INVALID_DESCRIPTOR" });
    expect(failure.detail).toContain('Path must be safe and relative at ["skills"][0]["path"]');
  }),
);
