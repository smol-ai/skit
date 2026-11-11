import { expect, test } from "vitest";
import { Schema } from "effect";
import { SourceRestoreInvalid } from "../src/library/source-restore-failures.js";
import { CommandFailed } from "../src/sources/fetch-failures.js";
import { SourceRequired } from "../src/sources/failures.js";
import { StepError } from "../src/library/store/state-schema.js";
import { stepError } from "../src/library/store/step-error.js";

test("an unexpected source error stays native instead of becoming a fieldless checked failure", () => {
  const original = new TypeError("Source reader failed", { cause: new Error("connection reset") });
  const failure = new SourceRestoreInvalid({
    hash: "sha256:expected",
    reason: { _tag: "SourceFetchFailed", failure: original },
  });
  expect(failure.reason).toMatchObject({ _tag: "SourceFetchFailed" });
  if (failure.reason._tag !== "SourceFetchFailed") throw new Error("Missing acquisition failure");
  expect(failure.reason.failure).toBe(original);
  expect(original).not.toHaveProperty("_tag");
  expect(stepError(failure)).toBe(failure);
  const wire = Schema.encodeSync(Schema.toCodecJson(StepError))(failure);
  const decoded = Schema.decodeUnknownSync(StepError)(JSON.parse(JSON.stringify(wire)));
  expect(decoded).toBeInstanceOf(SourceRestoreInvalid);
  expect(decoded).toMatchObject({
    reason: {
      failure: {
        name: "TypeError",
        message: "Source reader failed",
        cause: { message: "connection reset" },
      },
    },
  });
  expect(wire).not.toHaveProperty("message");
  expect(wire).not.toHaveProperty("remediation");
});

test.each([
  new SourceRequired(),
  new CommandFailed({ command: "git fetch", exitCode: 128, stderr: "revision unavailable" }),
])("checked source failure $._tag retains its object and exact stored fields", (original) => {
  const failure = new SourceRestoreInvalid({
    hash: "sha256:expected",
    reason: { _tag: "SourceFetchFailed", failure: original },
  });
  if (failure.reason._tag !== "SourceFetchFailed") throw new Error("Missing acquisition failure");
  expect(failure.reason.failure).toBe(original);
  const wire = Schema.encodeSync(SourceRestoreInvalid)(failure);
  expect(wire).toEqual({
    _tag: "Library.SyncSourceRestoreInvalid",
    hash: "sha256:expected",
    reason: {
      _tag: "SourceFetchFailed",
      failure: Schema.encodeSync(
        original._tag === "CommandFailed" ? CommandFailed : SourceRequired,
      )(original),
    },
  });
  const decoded = Schema.decodeUnknownSync(SourceRestoreInvalid)(JSON.parse(JSON.stringify(wire)));
  if (decoded.reason._tag !== "SourceFetchFailed")
    throw new Error("Missing stored acquisition failure");
  expect(decoded.reason.failure).toBeInstanceOf(original.constructor);
  expect(decoded.reason.failure).toMatchObject(original);
});
