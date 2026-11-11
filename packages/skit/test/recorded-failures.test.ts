import { RecoveryInvalid } from "../src/library/store/operation-failures.js";
import { SyncIssue } from "../src/library/sync-issues.js";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { InvalidIntent } from "../src/library/enabled-plan.js";
import {
  StepDefect,
  StepSchemaFailure,
  LegacyStepFailure,
} from "../src/library/recorded-failures.js";
import { StepError } from "../src/library/store/state-schema.js";
import { stepError } from "../src/library/store/step-error.js";

it("known failures retain their original object instead of being reduced to prose", () => {
  const original = new InvalidIntent({ intent: "Sync" });
  expect(stepError(original)).toBe(original);
  const wire = Schema.encodeSync(Schema.toCodecJson(StepError))(stepError(original));
  expect(wire).toEqual({ _tag: "Library.InvalidIntent", intent: "Sync" });
});

it.effect("a native schema error stays intact live and crosses JSON as schema facts", () =>
  Effect.gen(function* () {
    const original = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ enabled: Schema.Boolean }))({ enabled: "bad" }),
    );
    const recorded = stepError(original);
    expect(recorded).toBeInstanceOf(StepSchemaFailure);
    if (recorded instanceof StepSchemaFailure) expect(recorded.failure).toBe(original);
    const wire = Schema.encodeSync(Schema.toCodecJson(StepError))(recorded);
    const stored = Schema.decodeUnknownSync(StepError)(JSON.parse(JSON.stringify(wire)));
    expect(stored).toMatchObject({
      _tag: "Library.StepSchemaFailure",
      failure: {
        _tag: "StoredSchemaFailure",
        issues: [{ path: ["enabled"], reason: { _tag: "InvalidType" } }],
      },
    });
    expect(wire).not.toHaveProperty("message");
    expect(wire).not.toHaveProperty("remediation");
  }),
);

it("unexpected native exceptions remain native until the persistence boundary", () => {
  const original = new TypeError("native failure", { cause: new Error("native cause") });
  const recorded = stepError(original);
  expect(recorded).toBeInstanceOf(StepDefect);
  if (!(recorded instanceof StepDefect)) throw new Error("Missing defect");
  expect(recorded.defect).toBe(original);
  const wire = Schema.encodeSync(Schema.toCodecJson(StepError))(recorded);
  expect(wire).not.toHaveProperty("message");
  expect(wire).not.toHaveProperty("remediation");
  const stored = Schema.decodeUnknownSync(StepError)(JSON.parse(JSON.stringify(wire)));
  expect(stored).toBeInstanceOf(StepDefect);
  if (stored instanceof StepDefect)
    expect(stored.defect).toMatchObject({
      name: "TypeError",
      message: "native failure",
      cause: { message: "native cause" },
    });
});

it.each(["OldFailure", "Library.UpdateSelectionMissing"])(
  "historical %s prose stays historical even when its tag matches a current failure",
  (tag) => {
    const old = {
      _tag: tag,
      code: "CONFLICT",
      message: "old diagnostic",
      remediation: "old guidance",
    };
    expect(Schema.is(StepError)(old)).toBe(false);
    const stored = Schema.decodeUnknownSync(StepError)(old);
    expect(stored).toBeInstanceOf(LegacyStepFailure);
    if (!(stored instanceof LegacyStepFailure)) throw new Error("Missing historical record");
    expect(stored.failureTag).toBe(old._tag);
    expect(stored.originalCode).toBe(old.code);
    expect(stored.code).toBe("CONFLICT");
    const wire = Schema.encodeSync(Schema.toCodecJson(StepError))(stored);
    expect(wire).toEqual({
      _tag: "Library.LegacyStepFailure",
      failureTag: tag,
      originalCode: "CONFLICT",
      diagnostic: "old diagnostic",
      originalRemediation: "old guidance",
    });
  },
);

it("roundtrips recursive operation failures inside a saved sync issue", () => {
  const failure = new RecoveryInvalid({
    reason: {
      _tag: "OperationStopped",
      operation: "Undo",
      operationId: "undo-operation",
      reason: {
        _tag: "StepFailed",
        step: 2,
        error: new InvalidIntent({ intent: "Sync" }),
      },
    },
  });
  const issue = { _tag: "InstallationFailed", failure } as const;
  const wire = Schema.encodeSync(Schema.toCodecJson(SyncIssue))(issue);
  expect(wire).toEqual({
    _tag: "InstallationFailed",
    failure: {
      _tag: "RecoveryInvalid",
      reason: {
        _tag: "OperationStopped",
        operation: "Undo",
        operationId: "undo-operation",
        reason: {
          _tag: "StepFailed",
          step: 2,
          error: { _tag: "Library.InvalidIntent", intent: "Sync" },
        },
      },
    },
  });
  const restored = Schema.decodeUnknownSync(SyncIssue)(JSON.parse(JSON.stringify(wire)));
  expect(Schema.encodeSync(Schema.toCodecJson(SyncIssue))(restored)).toEqual(wire);
});
