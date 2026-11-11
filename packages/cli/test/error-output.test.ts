import { RecoveryInvalid } from "@smolai/skit-core/library";
import { SetupStopped } from "@smolai/skit-core/library/setup";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { RegistrySelectionAmbiguous } from "../src/registry/failures.js";
import { expect, test } from "vitest";
import { Cause, Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { CommandError } from "../src/commands/error-output.js";
import { classifyFailure, commandFailure } from "../src/commands/failure-classification.js";
import { renderFailureFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";
import { outputStories } from "../src/storybook/output-stories.js";
import { FindingFingerprintInvalid } from "../src/library/security/failures.js";
import { LibraryChanged } from "@smolai/skit-core/library";

const jsonEnvironment = { ...defaultTerminalEnvironment, format: "json" as const };

it.effect("makeEffect issues stay native and receive words before JSON encoding", () =>
  Effect.gen(function* () {
    const issue = yield* Schema.Struct({
      attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    })
      .makeEffect({ attempts: -1 })
      .pipe(Effect.flip);
    const failure = classifyFailure(issue);
    expect(failure.cause.reasons[0]?._tag === "Fail" && failure.cause.reasons[0].error).toBe(issue);
    expect(failure.message).toContain('Value must be at least 0 and at most 3 at ["attempts"]');
    const wire = Schema.encodeSync(CommandError)({ code: failure.code, cause: failure.cause });
    expect(wire.cause).toMatchObject([
      {
        _tag: "Fail",
        error: { issues: [{ path: ["attempts"], reason: { _tag: "InvalidValue" } }] },
      },
    ]);
    const stored = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
    expect(commandFailure(stored.cause).message).toBe(failure.message);
  }),
);

test("classification retains the exact original Cause and its ordered reasons", () => {
  const checked = new FindingFingerprintInvalid({ value: "sha256:short" });
  const defect = new TypeError("native filesystem defect", {
    cause: new Error("disk unavailable"),
  });
  const original = Cause.combine(Cause.fail(checked), Cause.die(defect));
  const failure = commandFailure(original);
  expect(failure.cause).toBe(original);
  expect(CommandError.make({ code: failure.code, cause: original }).cause).toBe(original);
  const frame = renderFailureFrame(failure, jsonEnvironment);
  expect(frame.stdout).toBe("");
  expect(frame.exitCode).toBe(2);
  expect(JSON.parse(frame.stderr)).toEqual({
    schema: "skit.error.v2",
    error: {
      code: "INVALID_ARGUMENT",
      cause: [
        { _tag: "Fail", error: { _tag: "FindingFingerprintInvalid", value: "sha256:short" } },
        {
          _tag: "Die",
          defect: {
            name: "TypeError",
            message: "native filesystem defect",
            cause: { name: "Error", message: "disk unavailable" },
          },
        },
      ],
    },
  });
});

test("independent checked failures retain both owners' facts", () => {
  const original = Cause.combine(
    Cause.fail(new FindingFingerprintInvalid({ value: "short" })),
    Cause.fail(new LibraryChanged({ path: "/library/state.json" })),
  );
  const payload = Schema.encodeSync(CommandError)({ code: "INVALID_ARGUMENT", cause: original });
  expect(payload.cause).toEqual([
    { _tag: "Fail", error: { _tag: "FindingFingerprintInvalid", value: "short" } },
    { _tag: "Fail", error: { _tag: "LibraryChanged", path: "/library/state.json" } },
  ]);
});

test("interruptions remain interruptions through the Effect codec", () => {
  const original = Cause.interrupt(42);
  const wire = Schema.encodeSync(CommandError)({ code: "OPERATION_FAILED", cause: original });
  expect(wire.cause).toEqual([{ _tag: "Interrupt", fiberId: 42 }]);
  const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
  expect(Cause.hasInterrupts(decoded.cause)).toBe(true);
});

it.effect("native validation errors stay live and encode ordered schema facts", () =>
  Effect.gen(function* () {
    const original = yield* Schema.decodeUnknownEffect(Schema.Struct({ enabled: Schema.Boolean }))({
      enabled: "bad",
    }).pipe(Effect.flip);
    const failure = classifyFailure(original);
    expect(failure.cause.reasons[0]?._tag === "Fail" && failure.cause.reasons[0].error).toBe(
      original,
    );
    const wire = Schema.encodeSync(CommandError)({ code: failure.code, cause: failure.cause });
    expect(wire.cause).toEqual([
      {
        _tag: "Fail",
        error: {
          issues: [
            { path: ["enabled"], reason: { _tag: "InvalidType", expected: [{ type: "Boolean" }] } },
          ],
        },
      },
    ]);
  }),
);

test.each(outputStories.filter((story) => story._tag === "Failure"))(
  "$name facts reconstruct its explanation after JSON",
  (story) => {
    if (story._tag !== "Failure") throw new Error("Expected a failure");
    const frame = renderFailureFrame(story.failure, jsonEnvironment);
    const envelope = JSON.parse(frame.stderr);
    expect(envelope.schema).toBe("skit.error.v2");
    expect(envelope.error).not.toHaveProperty("message");
    expect(envelope.error).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(CommandError)(envelope.error);
    expect(commandFailure(decoded.cause).presentation).toEqual(story.failure.presentation);
  },
);

test("a core source-restore wrapper retains CLI Registry facts and actions", () => {
  const child = new RegistrySelectionAmbiguous({
    origins: ["https://one.test", "https://two.test"],
    command: "skit auth logout <origin-or-alias>",
  });
  const original = new SourceRestoreInvalid({
    hash: "sha256:source",
    reason: { _tag: "SourceFetchFailed", failure: child },
  });
  const classified = classifyFailure(original);
  const wire = Schema.encodeSync(CommandError)({ code: classified.code, cause: classified.cause });
  const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
  expect(commandFailure(decoded.cause).presentation).toEqual(classified.presentation);
  const first = decoded.cause.reasons[0];
  expect(first?._tag === "Fail" && first.error).toMatchObject({
    _tag: "Library.SyncSourceRestoreInvalid",
    reason: {
      _tag: "SourceFetchFailed",
      failure: { _tag: "RegistrySelectionAmbiguous", origins: child.origins },
    },
  });
});

test("a stopped setup retains a nested source-restore Registry failure", () => {
  const child = new RegistrySelectionAmbiguous({
    origins: ["https://one.test", "https://two.test"],
    command: "skit auth logout <origin-or-alias>",
  });
  const original = new SetupStopped({
    operationId: "setup-1",
    reason: {
      _tag: "StepFailed",
      step: 0,
      error: new SourceRestoreInvalid({
        hash: "sha256:source",
        reason: { _tag: "SourceFetchFailed", failure: child },
      }),
    },
  });
  const classified = classifyFailure(original);
  const wire = Schema.encodeSync(CommandError)({ code: classified.code, cause: classified.cause });
  const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
  expect(commandFailure(decoded.cause).presentation).toEqual(classified.presentation);
});

test("recovery retains Registry facts nested through stopped operations", () => {
  const source = new SourceRestoreInvalid({
    hash: "sha256:source",
    reason: {
      _tag: "SourceFetchFailed",
      failure: new RegistrySelectionAmbiguous({
        origins: ["https://one.test", "https://two.test"],
        command: "skit auth logout <origin-or-alias>",
      }),
    },
  });
  const first = new RecoveryInvalid({
    reason: {
      _tag: "OperationStopped",
      operation: "Restore",
      operationId: "restore-1",
      reason: { _tag: "StepFailed", step: 1, error: source },
    },
  });
  const original = new RecoveryInvalid({
    reason: {
      _tag: "OperationStopped",
      operation: "Undo",
      operationId: "undo-1",
      reason: { _tag: "StepFailed", step: 2, error: first },
    },
  });
  const classified = classifyFailure(original);
  const wire = Schema.encodeSync(CommandError)({ code: classified.code, cause: classified.cause });
  const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
  expect(commandFailure(decoded.cause).presentation).toEqual(classified.presentation);
});

test("checked errors Effect converts to Die reasons retain their owner facts", () => {
  const checked = new FindingFingerprintInvalid({ value: "short" });
  const original = Cause.die(checked);
  const wire = Schema.encodeSync(CommandError)({ code: "INVALID_ARGUMENT", cause: original });
  expect(wire.cause).toEqual([
    { _tag: "Die", defect: { _tag: "FindingFingerprintInvalid", value: "short" } },
  ]);
  const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
  expect(commandFailure(decoded.cause).presentation).toEqual(commandFailure(original).presentation);
});
