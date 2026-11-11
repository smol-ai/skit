import { Cause } from "effect";
import { expect, test } from "vitest";
import { processExitCodes, resultExitCode } from "../src/commands/exit-code.js";
import { result } from "../src/commands/result.js";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderResultFrame,
} from "../src/commands/output-frame.js";
import { outputStories } from "../src/storybook/output-stories.js";
import { describeFailure } from "../src/terminal/failure.js";

const story = (group: string, name: string) => {
  const found = outputStories.find((item) => item.group === group && item.name === name);
  if (found === undefined || found._tag !== "Result")
    throw new Error(`Missing result story ${group}/${name}`);
  return found.result;
};

test("one shared policy covers success, failures and invalid usage in both output modes", () => {
  expect(processExitCodes).toEqual({ success: 0, failure: 1, invalidUsage: 2 });
  for (const format of ["human", "json"] as const) {
    const environment = { ...defaultTerminalEnvironment, format };
    expect(renderResultFrame(result("version", { version: "0.3.0" }), environment).exitCode).toBe(
      0,
    );
    for (const code of [
      "NOT_FOUND",
      "CONFLICT",
      "TARGET_COLLISION",
      "VALIDATION_FAILED",
      "AUTHENTICATION_REQUIRED",
      "OPERATION_FAILED",
    ] as const) {
      const frame = renderFailureFrame(
        {
          code,
          cause: Cause.fail(new Error("failure")),
          ...describeFailure({ summary: ["failure"], next: ["next step"] }),
        },
        environment,
      );
      expect(frame.exitCode).toBe(1);
      if (format === "json") expect(JSON.parse(frame.stderr).error.code).toBe(code);
    }
    expect(
      renderFailureFrame(
        {
          code: "INVALID_ARGUMENT",
          cause: Cause.fail(new Error("bad argument")),
          ...describeFailure({ summary: ["bad argument"], next: ["fix it"] }),
        },
        environment,
      ).exitCode,
    ).toBe(2);
  }
});

test("uniformly failed batches use failure even when an individual item's code is INVALID_ARGUMENT", () => {
  const output = result("update", [
    {
      status: "failed",
      subject_id: "collection",
      subject_kind: "collection",
      label: "tools",
      source: "/tools",
      phase: "source",
      source_imported: false,
      error: { code: "INVALID_ARGUMENT", cause: Cause.fail(new Error("bad source")) },
    },
  ]);
  const frame = renderResultFrame(output, { ...defaultTerminalEnvironment, format: "json" });
  expect(frame.exitCode).toBe(1);
  expect(JSON.parse(frame.stdout).data[0].error).toEqual({
    code: "INVALID_ARGUMENT",
    cause: [{ _tag: "Fail", error: { name: "Error", message: "bad source" } }],
  });
  expect(resultExitCode(result("update", []))).toBe(0);
});

test("invalid and policy-blocked validation results use failure while warning-only validation succeeds", () => {
  expect(resultExitCode(story("validate", "invalid"))).toBe(1);
  expect(resultExitCode(story("validate", "policy-blocked"))).toBe(1);
  expect(resultExitCode(story("validate", "warning"))).toBe(0);
});

test("later successful scopes retain a partial failure, while a repaired doctor's final verdict replaces it", () => {
  expect(resultExitCode(result("version", { version: "0.3.0" }), 1)).toBe(1);
  expect(resultExitCode(story("doctor", "healthy"), 1)).toBe(0);
});
