import { expect, test } from "vitest";
import { Schema } from "effect";
import { WorkspaceFailure } from "@smolai/skit-core/author/workspace-contracts";
import { classifyFailure } from "../src/commands/failure-classification.js";

const restored = (wire: unknown) => {
  const failure = Schema.decodeUnknownSync(WorkspaceFailure)(wire);
  const encoded = Schema.encodeSync(WorkspaceFailure)(failure);
  expect(encoded).toEqual(wire);
  expect(encoded).not.toHaveProperty("message");
  expect(encoded).not.toHaveProperty("remediation");
  return Schema.decodeUnknownSync(WorkspaceFailure)(JSON.parse(JSON.stringify(encoded)));
};

test("workspace conflicts keep retryability, paths and frontend recovery guidance", () => {
  const busy = restored({ _tag: "AuthorWorkspaceBusy", root: "/author" });
  expect(busy).toMatchObject({ code: "CONFLICT", retryable: true });
  expect(classifyFailure(busy)).toMatchObject({
    message: expect.stringContaining("/author"),
    remediation: expect.stringContaining("Wait for it to finish"),
  });
  const root = restored({ _tag: "AuthorWorkspaceRootInvalid", input: "/missing" });
  expect(classifyFailure(root)).toMatchObject({
    message: "/missing is not an existing directory",
  });
});

test("sync state failure facts produce schema paths and retain mismatched Registry locators", () => {
  const invalid = restored({
    _tag: "AuthorSyncStateInvalid",
    path: "/author-sync.json",
    reason: {
      _tag: "InvalidData",
      failure: {
        issues: [
          { path: ["requestId"], reason: { _tag: "InvalidType", expected: [{ type: "String" }] } },
        ],
      },
    },
  });
  expect(classifyFailure(invalid)).toMatchObject({
    message: expect.stringContaining('["requestId"]'),
    remediation: expect.stringContaining("Keep the sync state file"),
  });
  const mismatch = restored({
    _tag: "AuthorSyncStateInvalid",
    path: "/connection.json",
    reason: { _tag: "MismatchedRemote", actual: "tim/other", expected: "tim/tools" },
  });
  expect(classifyFailure(mismatch).message).toContain("it names tim/other, not tim/tools");
});

test("unsafe lock facts retain native SQLite errors without core-authored reason strings", () => {
  const unsafe = restored({
    _tag: "AuthorWorkspaceUnsafe",
    path: "/author/.skit/lock.sqlite",
    reason: {
      _tag: "LockFailed",
      cause: {
        error: { name: "Error", message: "file is not a database" },
        properties: { code: "ERR_SQLITE_ERROR", errcode: 26 },
      },
    },
  });
  expect(classifyFailure(unsafe)).toMatchObject({
    message: expect.stringContaining("file is not a database"),
    remediation: expect.stringContaining("move anything unexpected aside"),
  });
  const changed = restored({
    _tag: "AuthorWorkspaceUnsafe",
    path: "/author",
    reason: { _tag: "LeaseRootMismatch", leaseRoot: "/other-author" },
  });
  expect(classifyFailure(changed).message).toContain("lease belongs to a different root");
});
