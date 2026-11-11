import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import { CollectionId } from "@smolai/skit-core/universal/consumer";
import { SchemaFailure } from "@smolai/skit-core/shared";
import { schemaFailure } from "../src/library/schema-failure";

test("native TypeID validation and its stored facts have the same frontend explanation", () => {
  const result = Schema.decodeResult(Schema.Struct({ collection: CollectionId }))({
    collection: "not-an-id",
  });
  if (!Result.isFailure(result)) throw new Error("Invalid TypeID accepted");
  const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
  const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
  expect(schemaFailure(result.failure)).toBe('Expected a canonical coll TypeID at ["collection"]');
  expect(schemaFailure(result.failure.issue)).toBe(schemaFailure(result.failure));
  expect(schemaFailure(stored)).toBe(schemaFailure(result.failure));
});

test.each([
  [{ minimum: 0, maximum: 42 }, -1, "Value must be at least 0 and at most 42"],
  [
    { minimum: 0, maximum: 42, exclusiveMinimum: true, exclusiveMaximum: true },
    42,
    "Value must be greater than 0 and less than 42",
  ],
] as const)(
  "range constraints explain their bounds before and after storage: %j",
  (bounds, input, explanation) => {
    const result = Schema.decodeResult(Schema.Int.check(Schema.isBetween(bounds)))(input);
    if (!Result.isFailure(result)) throw new Error("Out-of-range value accepted");
    const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
    const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
    expect(schemaFailure(result.failure)).toBe(explanation);
    expect(schemaFailure(stored)).toBe(explanation);
  },
);
