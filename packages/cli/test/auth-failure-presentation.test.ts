import { expect, test } from "vitest";
import { Cause, Schema } from "effect";
import { systemError, isPlatformError } from "effect/PlatformError";
import {
  AuthFailure,
  SignInFailed,
  SignOutRejected,
  SignInFailureReason,
} from "../src/registry/auth-failures.js";
import { classifyFailure, commandError } from "../src/commands/failure-classification.js";
import { CommandError } from "../src/commands/error-output.js";
import { renderBlocks } from "../src/terminal/blocks.js";

const origin = "https://registry.test";
const storage = systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "rename",
  pathOrDescriptor: "/home/owner/.skit/auth.json",
});
const reasons = {
  RequestFailed: { _tag: "RequestFailed", operation: "credential-create" },
  ResponseInvalid: {
    _tag: "ResponseInvalid",
    operation: "credential-create",
    failure: new Error("connection reset"),
  },
  RequestInvalid: {
    _tag: "RequestInvalid",
    operation: "credential-revoke",
    failure: new Error("invalid token id"),
  },
  UnsupportedScopes: {
    _tag: "UnsupportedScopes",
    scopes: ["authoring:write", "publication:write"],
  },
  SessionMissing: { _tag: "SessionMissing" },
  MethodMissing: { _tag: "MethodMissing" },
  CredentialMissing: { _tag: "CredentialMissing" },
  DeviceExpiryInvalid: {
    _tag: "DeviceExpiryInvalid",
    expiresIn: 1e308,
    receivedAt: 1_800_000_000_000,
  },
  SessionEndFailed: {
    _tag: "SessionEndFailed",
    cleanup: { _tag: "ResponseRejected", status: 503 },
    original: new SignInFailed({ origin, reason: { _tag: "SessionMissing" } }),
  },
  StorageCleanupFailed: {
    _tag: "StorageCleanupFailed",
    tokenId: "credential-1",
    tokenPrefix: "skit_pat_abc",
    cleanup: { _tag: "ResponseRejected", status: 503 },
    original: storage,
  },
} satisfies {
  [K in (typeof SignInFailureReason.Type)["_tag"]]: Extract<
    typeof SignInFailureReason.Type,
    { _tag: K }
  >;
};

test.each(Object.entries(reasons))("%s retains facts and has an explicit action", (_, reason) => {
  const failure = new SignInFailed({ origin, reason });
  const codec = Schema.toCodecJson(AuthFailure);
  const encoded = Schema.encodeSync(codec)(failure);
  expect(encoded).not.toHaveProperty("message");
  expect(encoded).not.toHaveProperty("remediation");
  const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(encoded)));
  expect(decoded).toMatchObject({ _tag: "SignInFailed", origin, reason: { _tag: reason._tag } });
  expect(classifyFailure(decoded).next.length).toBeGreaterThan(0);
});

test("credential creation reports an unknown outcome without inventing HTTP 400", () => {
  const failure = new SignInFailed({ origin, reason: reasons.RequestFailed });
  const description = classifyFailure(failure);
  expect(description.message).toContain("could not be confirmed");
  expect(description.remediation).toContain("may have been created");
  expect(description.message).not.toContain("400");
});

test("failed session cleanup keeps the action for an uncertain credential creation", () => {
  const failure = new SignInFailed({
    origin,
    reason: {
      _tag: "SessionEndFailed",
      cleanup: { _tag: "ResponseRejected", status: 503 },
      original: new SignInFailed({ origin, reason: reasons.ResponseInvalid }),
    },
  });
  expect(classifyFailure(failure).remediation).toContain("End the temporary session");
  expect(classifyFailure(failure).remediation).toContain("Check and revoke unused credentials");
});

test.each(["error", "issue"] as const)(
  "native validation %s stays live and credentials are absent from rendered and encoded diagnostics",
  (kind) => {
    const validated = Schema.decodeUnknownExit(Schema.Struct({ access_token: Schema.String }))({
      access_token: { secret: "sensitive-session-value" },
    });
    if (validated._tag !== "Failure") throw new Error("Expected invalid credential response");
    const native = validated.cause.reasons[0];
    if (native?._tag !== "Fail") throw new Error("Expected native schema failure");
    const original = kind === "issue" ? native.error.issue : native.error;
    const failure = new SignInFailed({
      origin,
      reason: {
        _tag: "ResponseInvalid",
        operation: "device-token",
        status: 200,
        failure: original,
      },
    });
    expect(failure.reason).toHaveProperty("failure", original);
    if (failure.reason._tag !== "ResponseInvalid") throw new Error("Expected invalid response");
    expect(failure.reason.failure).toBe(original);
    const description = classifyFailure(failure);
    const terminal = renderBlocks(description.presentation, { color: false });
    expect(terminal).toContain("access_token");
    expect(terminal).not.toContain("sensitive-session-value");
    const codec = Schema.toCodecJson(AuthFailure);
    const wire = JSON.stringify(Schema.encodeSync(codec)(failure));
    expect(wire).not.toContain("sensitive-session-value");
    const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(wire));
    expect(classifyFailure(decoded).message).toContain("access_token");
  },
);

test("cleanup retains its original platform failure through the real command JSON boundary", () => {
  const failure = new SignInFailed({ origin, reason: reasons.StorageCleanupFailed });
  expect(failure.reason).toHaveProperty("original", storage);
  const cause = Cause.fail(failure);
  const output = commandError(cause);
  expect(output.cause).toBe(cause);
  const encoded = Schema.encodeSync(CommandError)(output);
  const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(encoded)));
  const recovered = decoded.cause.reasons[0];
  if (
    recovered?._tag !== "Fail" ||
    !Schema.is(SignInFailed)(recovered.error) ||
    recovered.error.reason._tag !== "StorageCleanupFailed"
  )
    throw new Error("Expected stored cleanup failure");
  expect(isPlatformError(recovered.error.reason.original)).toBe(true);
  expect(recovered.error.reason.original).toMatchObject({
    reason: { _tag: "PermissionDenied", method: "rename" },
  });
  expect(classifyFailure(recovered.error).message).toContain("auth.json");
  expect(
    classifyFailure(recovered.error).presentation.filter(
      (block) => block._tag === "Fields" && block.rows.some((row) => row.label === "Next"),
    ),
  ).toHaveLength(1);
});

test.each([
  { _tag: "RequestInvalid", failure: new Error("invalid request") },
  { _tag: "ResponseRejected", status: 503, registryCode: "storage_failure" },
] as const)("logout $ _tag says the local credential was kept", (reason) => {
  const failure = new SignOutRejected({ origin, reason });
  expect(classifyFailure(failure).message).toContain("saved credential was kept");
});
