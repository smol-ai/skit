import { expect, test } from "vitest";
import { Schema } from "effect";
import { CollectionVersionArchiveInvalid } from "@smolai/skit-core/universal/consumer";
import { classifyFailure } from "../src/commands/failure-classification.js";

test("Collection Version archive failures keep both hash facts and get CLI wording after decoding", () => {
  const expected = `sha256:${"a".repeat(64)}`,
    actual = `sha256:${"b".repeat(64)}`;
  const error = new CollectionVersionArchiveInvalid({
    reason: { _tag: "HashMismatch", kind: "archive", expected, actual },
  });
  const encoded = Schema.encodeSync(CollectionVersionArchiveInvalid)(error);
  expect(encoded).toEqual({
    _tag: "Library.SnapshotArchiveInvalid",
    reason: { _tag: "HashMismatch", kind: "archive", expected, actual },
  });
  const formatted = classifyFailure(
    Schema.decodeUnknownSync(CollectionVersionArchiveInvalid)(JSON.parse(JSON.stringify(encoded))),
  );
  expect(formatted).toMatchObject({ code: "OPERATION_FAILED" });
  expect(formatted.message).toContain(expected);
  expect(formatted.message).toContain(actual);
  expect(formatted.remediation).toContain("skit sync");
});
