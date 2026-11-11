import { Block } from "../src/terminal/blocks.js";
import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import { CollectionId } from "@smolai/skit-core/universal/consumer";
import { SchemaFailure } from "@smolai/skit-core/shared";
import { schemaFailure } from "../src/platform/schema-failure.js";
import { StepSchemaFailure } from "@smolai/skit-core/library/recorded-failures";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { renderFailureFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";

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

// These are the Effect 4.1.2 built-ins used by SKIT, including checks introduced by
// Int / Finite / NonEmptyString. Assert actionable bounds after the real JSON codec.
test.each([
  [
    () => Schema.decodeUnknownResult(Schema.Number.check(Schema.isGreaterThan(0)))(-1),
    "Value must be greater than 0",
  ],
  [
    () => Schema.decodeUnknownResult(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)))(0),
    "Value must be at least 1",
  ],
  [
    () => Schema.decodeUnknownResult(Schema.Number.check(Schema.isLessThan(10)))(10),
    "Value must be less than 10",
  ],
  [
    () => Schema.decodeUnknownResult(Schema.Number.check(Schema.isLessThanOrEqualTo(1)))(2),
    "Value must be at most 1",
  ],
  [() => Schema.decodeUnknownResult(Schema.Int)(0.5), "Value must be a safe integer"],
  [() => Schema.decodeUnknownResult(Schema.Finite)(Infinity), "Value must be a finite number"],
  [
    () => Schema.decodeUnknownResult(Schema.String.check(Schema.isUUID(4)))("invalid"),
    "Value must be a UUID v4",
  ],
  [
    () => Schema.decodeUnknownResult(Schema.String.check(Schema.isUUID()))("invalid"),
    "Value must be a UUID",
  ],
  [
    () =>
      Schema.decodeUnknownResult(Schema.String.check(Schema.isStartingWith("/api/skits/")))(
        "/wrong",
      ),
    'Value must start with "/api/skits/"',
  ],
  [() => Schema.decodeUnknownResult(Schema.NonEmptyString)(""), "Length must be at least 1"],
  [
    () => Schema.decodeUnknownResult(Schema.String.check(Schema.isMaxLength(3)))("long"),
    "Length must be at most 3",
  ],
  [
    () => Schema.decodeUnknownResult(Schema.String.check(Schema.isPattern(/^skill$/i)))("wrong"),
    "Value must match ^skill$ (i)",
  ],
] as const)("stored constraints retain actionable meaning: %s", (invalid, explanation) => {
  const result: Result.Result<unknown, Schema.SchemaError> = invalid();
  if (!Result.isFailure(result)) throw new Error("Invalid value accepted");
  const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
  const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
  expect(schemaFailure(stored)).toBe(explanation);
});

test("a stored constraint retains its field path in rendered command output", () => {
  const result = Schema.decodeUnknownResult(
    Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThan(0)) }),
  )({ count: 0 });
  if (!Result.isFailure(result)) throw new Error("Invalid count accepted");
  const original = new StepSchemaFailure({ failure: result.failure });
  const wire = Schema.encodeSync(Schema.toCodecJson(StepSchemaFailure))(original);
  const stored = Schema.decodeUnknownSync(StepSchemaFailure)(JSON.parse(JSON.stringify(wire)));
  expect(schemaFailure(stored.failure)).toBe('Value must be greater than 0 at ["count"]');
  const frame = renderFailureFrame(classifyFailure(stored), {
    ...defaultTerminalEnvironment,
    color: false,
  });
  expect(classifyFailure(stored).explanation).toContainEqual(
    Block.List({ items: [{ text: ['Value must be greater than 0 at ["count"]'] }] }),
  );
  expect(frame.exitCode).toBe(1);
});
