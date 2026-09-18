import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { parseContractEffect } from "../src/distribution/api-contracts.js";

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
