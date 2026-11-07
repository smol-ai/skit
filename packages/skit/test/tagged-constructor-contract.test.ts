import { Schema } from "effect";
import { expect, test } from "vitest";
import { SourcePolicyViolationReason } from "../src/sources/resolve.js";

test("Transport supplies its constructor tag while decoding still requires it", () => {
  const transport = SourcePolicyViolationReason.members[0];
  expect(transport.make({ detail: "refused" })).toEqual({ _tag: "Transport", detail: "refused" });
  expect(() => Schema.decodeUnknownSync(transport)({ detail: "refused" })).toThrow();
  expect(() => Schema.decodeUnknownSync(transport)({ _tag: "Wrong", detail: "refused" })).toThrow();
  expect(Schema.encodeSync(transport)({ _tag: "Transport", detail: "refused" })).toEqual({
    _tag: "Transport",
    detail: "refused",
  });
});
