import { failureExitCode } from "../src/commands/exit-code.js";
import { test, expect } from "vitest";
import { Schema } from "effect";
import { RecoveryInvalid } from "@smolai/skit-core/library";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { SetupUndoOutput, renderSetupUndo } from "../src/library/setup/undo-result.js";
import { Block } from "../src/terminal/blocks.js";

test("stopped recovery formats its nested recorded recovery failure", () => {
  const failure = new RecoveryInvalid({
    reason: {
      _tag: "OperationStopped",
      operation: "Undo",
      operationId: "outer-operation",
      reason: {
        _tag: "StepFailed",
        step: 1,
        error: new RecoveryInvalid({
          reason: { _tag: "UnsafePath", kind: "original-parent", path: "/skills/review" },
        }),
      },
    },
  });
  const decoded = Schema.decodeUnknownSync(RecoveryInvalid)(
    Schema.encodeSync(RecoveryInvalid)(failure),
  );
  const formatted = classifyFailure(decoded);
  expect(formatted.code).toBe("CONFLICT");
  expect(failureExitCode(formatted.code)).toBe(1);
  expect(formatted.message).toContain("Recorded undo stopped");
  expect(formatted.message).not.toContain("outer-operation");
  expect(formatted.message).toContain("Redirected original parent: /skills/review");
  expect(formatted.remediation).toContain("keep both");
  if (decoded.reason._tag !== "OperationStopped" || decoded.reason.reason._tag !== "StepFailed")
    throw new Error("Expected a stopped recovery step");
  expect(decoded.reason.operationId).toBe("outer-operation");
  expect(formatted.presentation).toContainEqual(
    Block.Group({
      title: "Step 2 failed",
      children: classifyFailure(decoded.reason.reason.error).explanation,
    }),
  );
});

test("undo JSON keeps conflict facts while its presenter writes the sentence", () => {
  const data = SetupUndoOutput.make({
    operationId: "operation",
    status: "conflicted",
    phase: "preview",
    conflicts: [{ _tag: "ParentChanged", path: "/skills/review" }],
    files: [],
    intentChanged: false,
    settingsChanged: false,
    sourceSelections: [],
    actions: [],
  });
  const encoded = Schema.encodeSync(SetupUndoOutput)(data);
  expect(encoded.conflicts).toEqual([{ _tag: "ParentChanged", path: "/skills/review" }]);
  expect(renderSetupUndo(data)).toContainEqual(
    Block.Group({
      title: "Conflicts",
      children: [Block.List({ items: [{ text: ["Original parent changed: /skills/review"] }] })],
    }),
  );
});
