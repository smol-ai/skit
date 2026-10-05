import { it } from "@effect/vitest";
import { Effect, JsonSchema, Schema } from "effect";
import { expect } from "vitest";
import { parseContractEffect } from "../src/distribution/api-contracts.js";

import {
  apiSemverPattern,
  parseWireDescriptor,
  semver,
  skitDescriptorRequestSchema,
} from "../src/protocol/api-contracts.js";
import { Digest } from "../src/library/store/state-schema.js";
import { kebabNameSchema } from "../src/schemas.js";

const ExampleContract = Schema.Struct({
  name: Schema.String,
  nested: Schema.Struct({ count: Schema.Number }),
});

const invalidExample = { name: 1, nested: { count: "many" } };

it.effect("preserves every Effect Schema issue path", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      parseContractEffect("example", ExampleContract, invalidExample),
    );

    expect(error.issues.map((issue) => issue.path)).toEqual(["name", "nested.count"]);
  }),
);

it.effect(
  "descriptor requests retain nested extension fields and reject invalid declared fields",
  () =>
    Effect.gen(function* () {
      const descriptor = {
        skit: 1,
        id: "team/tools",
        slug: "tools",
        extension: { retained: true },
        author: { name: "Team", extension: "author" },
        skills: [
          {
            name: "review",
            path: "skills/review",
            default_enabled: true,
            extension: "skill",
            shared: [{ from: "shared/rules", to: "rules", extension: "mapping" }],
          },
        ],
      };
      const decoded = yield* Schema.decodeUnknownEffect(skitDescriptorRequestSchema)(descriptor);
      expect(decoded).toEqual(descriptor);
      expect(parseWireDescriptor(descriptor)).toEqual(descriptor);
      expect(
        parseWireDescriptor({ ...descriptor, skills: [{ ...descriptor.skills[0], name: "BAD" }] }),
      ).toBeNull();
    }),
);

it.effect("exported JSON schemas retain the name, digest, and version constraints", () =>
  Effect.sync(() => {
    for (const [schema, pattern] of [
      [kebabNameSchema, "^[a-z0-9]+(?:-[a-z0-9]+)*$"],
      [Digest, "^sha256:[a-f0-9]{64}$"],
      [semver, apiSemverPattern.source],
    ] as const) {
      const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema));
      expect(document.schema).toMatchObject({ pattern });
    }
  }),
);
