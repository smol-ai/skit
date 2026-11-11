import { expect, expectTypeOf, test } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema, Logger, type SchemaAST } from "effect";
import type { ErrorCode } from "yaml";
import { parseSkitConfig, parseSkitReadme } from "../src/artifact/descriptor.js";
import { DescriptorMalformed } from "../src/artifact/failures.js";
import { YamlErrorCode } from "../src/artifact/descriptor-issue.js";
import { ExpectedSchemaType, SchemaFailure } from "../src/shared/schema-issue.js";

test("diagnostic facts stay exhaustive over the installed schema engine and YAML error codes", () => {
  expectTypeOf<SchemaAST.AST["_tag"]>().toEqualTypeOf<ExpectedSchemaType>();
  expectTypeOf<ErrorCode>().toEqualTypeOf<YamlErrorCode>();
});

it.effect("schema diagnostics retain field paths and check payloads without rendered prose", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      parseSkitConfig(
        JSON.stringify({
          slug: "INVALID",
          skills: [{ name: "review", path: "../escape" }],
          extra: true,
        }),
      ),
    );
    expect(failure._tag).toBe("DescriptorMalformed");
    if (failure._tag !== "DescriptorMalformed") throw new Error("Expected descriptor diagnostics");
    expect(failure.issue._tag).toBe("Schema");
    if (failure.issue._tag !== "Schema") throw new Error("Expected schema diagnostics");
    expect(Schema.isSchemaError(failure.issue.failure)).toBe(true);
    const boundary = Schema.encodeSync(SchemaFailure)(failure.issue.failure);
    expect(boundary.issues).toContainEqual({
      path: ["extra"],
      reason: { _tag: "UnexpectedKey" },
    });
    expect(boundary.issues).toContainEqual({
      path: ["skills", 0, "path"],
      reason: { _tag: "InvalidValue", check: { id: "skit/schema/path-relative", payload: null } },
    });
    expect(boundary.issues).toContainEqual({
      path: ["slug"],
      reason: {
        _tag: "InvalidValue",
        check: {
          id: "effect/schema/isPattern",
          payload: { source: "^[a-z0-9]+(?:-[a-z0-9]+)*$", flags: "u" },
        },
      },
    });
    const encoded = Schema.encodeSync(DescriptorMalformed)(failure);
    expect(JSON.stringify(encoded)).not.toContain("message");
    expect(JSON.stringify(encoded)).not.toContain("must");
    const restored = Schema.decodeUnknownSync(DescriptorMalformed)(
      JSON.parse(JSON.stringify(encoded)),
    );
    expect(Schema.encodeSync(DescriptorMalformed)(restored)).toEqual(encoded);
  }),
);

it.effect(
  "schema diagnostics distinguish missing fields, wrong types and allowed literal values",
  () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        parseSkitConfig(
          JSON.stringify({ slug: 3, skills: [{ name: "review", invocation: "sometimes" }] }),
        ),
      );
      if (failure._tag !== "DescriptorMalformed" || failure.issue._tag !== "Schema")
        throw new Error("Expected schema diagnostics");
      expect(Schema.isSchemaError(failure.issue.failure)).toBe(true);
      const boundary = Schema.encodeSync(SchemaFailure)(failure.issue.failure);
      expect(boundary.issues).toContainEqual({
        path: ["slug"],
        reason: { _tag: "InvalidType", expected: [{ type: "String" }] },
      });
      expect(boundary.issues).toContainEqual({
        path: ["skills", 0, "path"],
        reason: { _tag: "MissingKey" },
      });
      const invocation = boundary.issues.filter((issue) => issue.path.at(-1) === "invocation");
      expect(invocation).toContainEqual({
        path: ["skills", 0, "invocation"],
        reason: {
          _tag: "InvalidType",
          expected: [
            { type: "Literal", values: ["explicit"] },
            { type: "Literal", values: ["implicit"] },
            { type: "Literal", values: ["host-policy"] },
          ],
        },
      });
    }),
);

it.effect(
  "syntax and YAML alias failures remain validation failures with structured categories",
  () =>
    Effect.gen(function* () {
      const json = yield* Effect.flip(parseSkitConfig("{"));
      expect(json).toMatchObject({
        _tag: "DescriptorMalformed",
        code: "VALIDATION_FAILED",
        format: "json",
        issue: { _tag: "JsonSyntax" },
      });
      const yaml = yield* Effect.flip(parseSkitReadme("---\nskit: [\n---\n"));
      expect(yaml).toMatchObject({
        _tag: "DescriptorMalformed",
        code: "VALIDATION_FAILED",
        format: "yaml",
        issue: {
          _tag: "YamlSyntax",
          errors: [{ code: "BAD_INDENT", start: 7, end: 8, line: 1, column: 8 }],
        },
      });
      const alias = yield* Effect.flip(parseSkitReadme("---\nskit: *missing\n---\n"));
      expect(alias).toMatchObject({
        _tag: "DescriptorMalformed",
        code: "VALIDATION_FAILED",
        issue: { _tag: "YamlValue" },
      });
    }),
);

it.effect("nonfatal YAML warnings remain visible as facts without rejecting the descriptor", () =>
  Effect.gen(function* () {
    const warnings: unknown[] = [];
    const descriptor = yield* parseSkitReadme(
      "---\nskit: 1\nslug: !unknown tools\nskills:\n  - name: review\n    path: review\n    default_enabled: true\n---\n",
    ).pipe(Effect.provide(Logger.layer([Logger.make((entry) => warnings.push(entry.message))])));
    expect(descriptor.slug).toBe("tools");
    expect(warnings).toEqual([
      [{ _tag: "YamlWarning", code: "TAG_RESOLVE_FAILED", start: 14, end: 22, line: 2, column: 7 }],
    ]);
    expect(JSON.stringify(warnings)).not.toContain("message");
  }),
);
