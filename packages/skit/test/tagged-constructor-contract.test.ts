import { Schema } from "effect";
import { expect, test } from "vitest";
import { SourcePolicyViolationReason } from "../src/sources/resolve.js";

test("HttpStatus supplies its constructor tag while decoding still requires it", () => {
  const transport = SourcePolicyViolationReason.cases.HttpStatus;
  expect(transport.make({ url: "https://source.test", status: 403 })).toEqual({
    _tag: "HttpStatus",
    url: "https://source.test",
    status: 403,
  });
  expect(() =>
    Schema.decodeUnknownSync(transport)({ url: "https://source.test", status: 403 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(transport)({ _tag: "Wrong", url: "https://source.test", status: 403 }),
  ).toThrow();
  expect(
    Schema.encodeSync(transport)({ _tag: "HttpStatus", url: "https://source.test", status: 403 }),
  ).toEqual({
    _tag: "HttpStatus",
    url: "https://source.test",
    status: 403,
  });
});
