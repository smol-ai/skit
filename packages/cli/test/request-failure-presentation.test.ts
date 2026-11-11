import { CommandError } from "../src/commands/error-output.js";
import { expect, test } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import * as Request from "../src/registry/request-failures.js";
import { classifyFailure, commandFailure } from "../src/commands/failure-classification.js";
import { Block } from "../src/terminal/blocks.js";
import {
  classifyRegistryApiFailure,
  markRegistryResponseDecoding,
  registryContractFailure,
} from "../src/registry/api-client.js";
import { SkitContractError } from "@smolai/skit-core/api";
import { AuthorWatchOutput } from "../src/author/watch-output.js";

const cases = {
  RegistryTransportError: new Request.RegistryTransportError({
    cause: new Error("connection reset"),
  }),
  AuthorListResponseError: new Request.AuthorListResponseError({
    origin: "https://registry.test",
    status: 503,
    registryCode: "storage_failure",
    failure: new Error("HTTP 503"),
  }),
  AuthorDeleteResponseError: new Request.AuthorDeleteResponseError({
    origin: "https://registry.test",
    status: 503,
    failure: new Error("HTTP 503"),
  }),
  AuthorSkitNotFound: new Request.AuthorSkitNotFound(),
  AuthorListPaginationError: new Request.AuthorListPaginationError({
    origin: "https://registry.test",
  }),
  PublicationResponseError: new Request.PublicationResponseError({
    reason: {
      _tag: "ResponseFailure",
      origin: "https://registry.test",
      status: 503,
      failure: new Error("HTTP 503"),
    },
  }),
  AuthorRequestFailed: new Request.AuthorRequestFailed({
    origin: "https://registry.test",
    operation: "current",
    status: 502,
    failure: new Error("HTTP 502"),
  }),
  AuthorRequestTimedOut: new Request.AuthorRequestTimedOut({
    origin: "https://registry.test",
    operation: "move",
    timeoutMs: 30_000,
  }),
  "Library.LibraryApiRejected": new Request.LibraryApiRejected({
    status: 403,
    reason: "forbidden",
  }),
  "Library.LibraryApiInvalidResponse": new Request.LibraryApiInvalidResponse({
    operation: "read portable Library",
  }),
  "Library.LibraryManifestTooNew": new Request.LibraryManifestTooNew({
    observed: "skit.library.v999",
    supported: "skit.library.v8",
  }),
  "Library.LibraryApiInvalidRequest": new Request.LibraryApiInvalidRequest(),
} satisfies {
  [K in Request.RegistryRequestFailure["_tag"]]: Extract<
    Request.RegistryRequestFailure,
    { _tag: K }
  >;
};

test.each(Object.entries(cases))(
  "%s retains its facts and presentation through watcher JSON",
  (_, failure) => {
    const event = { event: "retrying" as const, operation: "sync" as const, failure };
    const made = AuthorWatchOutput.make(event);
    expect(made.event === "retrying" && made.failure).toBe(failure);
    const wire = Schema.encodeSync(AuthorWatchOutput)(event);
    const decoded = Schema.decodeUnknownSync(AuthorWatchOutput)(JSON.parse(JSON.stringify(wire)));
    expect(decoded.event).toBe("retrying");
    if (decoded.event !== "retrying") throw new Error("Missing retry event");
    expect(decoded.failure).toMatchObject({ _tag: failure._tag, code: failure.code });
    expect(classifyFailure(decoded.failure).presentation).toEqual(
      Request.registryRequestFailure(failure).presentation,
    );
    expect(Request.registryRequestFailure(failure).next.length).toBeGreaterThan(0);
  },
);

test("HTTP status and Registry code are distinct facts, not an invented explanation", () => {
  const failure = classifyFailure(cases["Library.LibraryApiRejected"]);
  expect(failure.explanation).toEqual([
    Block.Status({ tone: "error", text: ["The Registry rejected the Library request"] }),
    Block.Fields({
      rows: [
        { label: "HTTP status", value: ["403"] },
        { label: "Registry code", value: [{ code: "forbidden" }] },
      ],
    }),
  ]);
  expect(failure.next).toContainEqual({ code: "skit sync" });
  expect(classifyFailure(new Request.LibraryApiRejected({ status: 502 })).next).toEqual([
    "Check the Registry response, then run ",
    { code: "skit sync" },
    " again.",
  ]);
});

it.effect("native response validation stays intact, while codecs store ordered schema facts", () =>
  Effect.gen(function* () {
    const original = yield* Schema.decodeUnknownEffect(Schema.Struct({ library: Schema.String }))({
      library: 42,
    }).pipe(Effect.flip);
    const marked = yield* markRegistryResponseDecoding(Effect.fail(original)).pipe(Effect.flip);
    const classified = classifyRegistryApiFailure(marked, [200]);
    expect(classified.kind).toBe("response_decode");
    if (classified.kind !== "response_decode")
      return yield* Effect.die(new Error("Missing decode failure"));
    expect(classified.failure).toBe(original);
    const contract = registryContractFailure("Library response", classified.failure);
    expect(contract.reason._tag).toBe("InvalidData");
    if (contract.reason._tag !== "InvalidData")
      return yield* Effect.die(new Error("Missing native validation"));
    expect(contract.reason.failure).toBe(original);
    const failure = new Request.LibraryApiInvalidResponse({
      operation: "read portable Library",
      failure: original,
    });
    expect(failure.failure).toBe(original);
    const codec = Schema.toCodecJson(Request.RegistryRequestFailure);
    const wire = yield* Schema.encodeEffect(codec)(failure);
    expect(wire).toMatchObject({
      failure: {
        issues: [{ path: ["library"], reason: { _tag: "InvalidType" } }],
      },
    });
    const stored = yield* Schema.decodeUnknownEffect(codec)(JSON.parse(JSON.stringify(wire)));
    const shown = classifyFailure(stored);
    const diagnostics = shown.explanation.find((block) => block._tag === "List");
    expect(diagnostics?._tag).toBe("List");
    if (diagnostics?._tag !== "List")
      return yield* Effect.die(new Error("Missing schema diagnostics"));
    expect(diagnostics.items).toEqual([{ text: ['Expected string at ["library"]'] }]);
  }),
);

test("a failed response read remains native and distinct from invalid contract data", () => {
  const original = new Error("body read failed", { cause: new Error("connection reset") });
  const failure = registryContractFailure("publish response", original);
  expect(failure.reason).toMatchObject({ _tag: "ReadFailed" });
  if (failure.reason._tag !== "ReadFailed") throw new Error("Missing read failure");
  expect(failure.reason.failure).toBe(original);
  const wire = Schema.encodeSync(SkitContractError)(failure);
  expect(wire).not.toHaveProperty("message");
  expect(wire).not.toHaveProperty("remediation");
  const decoded = Schema.decodeUnknownSync(SkitContractError)(JSON.parse(JSON.stringify(wire)));
  expect(decoded.reason).toMatchObject({
    _tag: "ReadFailed",
    failure: { message: "body read failed", cause: { message: "connection reset" } },
  });
  expect(classifyFailure(decoded).explanation).toEqual([
    Block.Status({ tone: "error", text: ["Unable to read ", { code: "publish response" }] }),
    Block.Note({ text: ["body read failed"] }),
  ]);
});

test("response metadata stays distinct from the domain failure code and preserves the original error", () => {
  const original = new Error("native response failure", { cause: new Error("body unavailable") });
  const failure = new Request.AuthorListResponseError({
    origin: "https://registry.test",
    status: 503,
    registryCode: "storage_failure",
    failure: original,
  });
  expect(failure.code).toBe("OPERATION_FAILED");
  expect(failure.registryCode).toBe("storage_failure");
  expect(failure.failure).toBe(original);
  const wire = Schema.encodeSync(Request.RegistryRequestFailure)(failure);
  expect(wire).toMatchObject({
    _tag: "AuthorListResponseError",
    status: 503,
    registryCode: "storage_failure",
  });
  expect(wire).not.toHaveProperty("message");
});

test("an unknown author write response has no invented HTTP status or blind retry action", () => {
  const failure = new Request.AuthorRequestFailed({
    origin: "https://registry.test",
    operation: "post",
    failure: new Error("unknown response"),
  });
  expect(Schema.encodeSync(Request.RegistryRequestFailure)(failure)).not.toHaveProperty("status");
  expect(Request.registryRequestFailure(failure).next).toEqual([
    "The request may have reached the Registry. Check its current state before retrying.",
  ]);
});

test("a publication server failure leaves its outcome unknown and preserves the raw body", () => {
  const failure = new Request.PublicationResponseError({
    reason: {
      _tag: "ResponseFailure",
      origin: "https://registry.test",
      status: 502,
      body: "upstream unavailable\n  proxy detail",
      failure: new Error("HTTP 502"),
    },
  });
  const formatted = Request.registryRequestFailure(failure);
  expect(formatted.explanation[0]).toEqual(
    Block.Status({ tone: "error", text: ["Publication could not be confirmed"] }),
  );
  expect(formatted.explanation).toContainEqual(
    Block.Verbatim({ text: "upstream unavailable\n  proxy detail" }),
  );
  expect(formatted.next).toEqual([
    "The release may have been published. Check the Registry's releases before retrying.",
  ]);
});

it.effect("an invalid publication acknowledgement keeps the native validation error live", () =>
  Effect.gen(function* () {
    const original = yield* Schema.decodeUnknownEffect(Schema.Struct({ release: Schema.String }))(
      {},
    ).pipe(Effect.flip);
    const failure = new Request.PublicationResponseError({
      reason: {
        _tag: "AcknowledgementInvalid",
        origin: "https://registry.test",
        failure: original,
      },
    });
    expect(failure.reason._tag === "AcknowledgementInvalid" && failure.reason.failure).toBe(
      original,
    );
    const wire = Schema.encodeSync(CommandError)({
      code: failure.code,
      cause: Cause.fail(failure),
    });
    const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
    expect(commandFailure(decoded.cause).presentation).toEqual(
      classifyFailure(failure).presentation,
    );
    expect(Request.registryRequestFailure(failure).next).toEqual([
      "The release may have been published. Check the Registry's releases before retrying.",
    ]);
  }),
);
