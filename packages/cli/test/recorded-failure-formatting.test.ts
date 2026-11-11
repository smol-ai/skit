import { CommandError } from "../src/commands/error-output.js";
import { expect, test } from "vitest";
import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import {
  StepDefect,
  StepSchemaFailure,
  LegacyStepFailureFromText,
} from "@smolai/skit-core/library/recorded-failures";
import { UpdateSelectionMissing } from "@smolai/skit-core/library/setup/failures";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { outputStories } from "../src/storybook/output-stories.js";
import { renderFailureFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";

test("native defects retain their explanation after a JSON boundary", () => {
  const failure = new StepDefect({ defect: new TypeError("native disk failure") });
  const wire = Schema.encodeSync(Schema.toCodecJson(StepDefect))(failure);
  const stored = Schema.decodeUnknownSync(StepDefect)(JSON.parse(JSON.stringify(wire)));
  expect(classifyFailure(stored).presentation).toEqual(classifyFailure(failure).presentation);
  expect(classifyFailure(stored).message).toBe("native disk failure");
  expect(classifyFailure(stored).message).not.toContain("StepDefect");
});

it.effect(
  "native schema errors and stored schema facts produce the same frontend explanation",
  () =>
    Effect.gen(function* () {
      const native = yield* Effect.flip(
        Schema.decodeUnknownEffect(Schema.Struct({ enabled: Schema.Boolean }))({ enabled: "bad" }),
      );
      const failure = new StepSchemaFailure({ failure: native });
      const wire = yield* Schema.encodeEffect(Schema.toCodecJson(StepSchemaFailure))(failure);
      const stored = yield* Schema.decodeUnknownEffect(StepSchemaFailure)(
        JSON.parse(JSON.stringify(wire)),
      );
      const formatted = classifyFailure(stored);
      expect(formatted.presentation).toEqual(classifyFailure(failure).presentation);
      expect(formatted.message).toContain("enabled");
      expect(formatted.message).toContain("boolean");
      expect(formatted.message).not.toContain("StoredSchemaFailure");
    }),
);

test("historical wording remains historical evidence rather than inferred modern facts", () => {
  const failure = Schema.decodeUnknownSync(LegacyStepFailureFromText)({
    _tag: "OldFailure",
    code: "CONFLICT",
    message: "historical diagnostic",
    remediation: "historical guidance",
  });
  expect(classifyFailure(failure)).toMatchObject({
    code: "CONFLICT",
    message: "historical diagnostic",
    remediation: "historical guidance",
  });
});

test("the CLI owns the refusal to replay an older unreviewed update selection", () => {
  const failure = new UpdateSelectionMissing();
  const wire = Schema.encodeSync(Schema.toCodecJson(UpdateSelectionMissing))(failure);
  expect(wire).toEqual({ _tag: "Library.UpdateSelectionMissing" });
  expect(classifyFailure(failure).message).toContain("did not record which Skills were selected");
  expect(classifyFailure(failure).remediation).toContain("skit setup");
});

test("Atlas failure frames encode stored schema facts and an older unreviewed update", () => {
  for (const [name, explanation] of [
    ["recorded-schema-failure", "enabled"],
    ["update-selection-not-recorded", "did not record which Skills were selected"],
  ]) {
    const story = outputStories.find((story) => story.name === name);
    if (story?._tag !== "Failure") throw new Error(`Missing ${name}`);
    const frame = renderFailureFrame(story.failure, {
      ...defaultTerminalEnvironment,
      color: false,
      width: 100,
      format: "json",
    });
    const error = JSON.parse(frame.stderr).error;
    expect(error).not.toHaveProperty("message");
    expect(error).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(CommandError)(error);
    const first = decoded.cause.reasons[0];
    expect(first?._tag).toBe("Fail");
    if (first?._tag !== "Fail") throw new Error("Missing checked failure");
    expect(classifyFailure(first.error).message).toContain(explanation);
    expect(frame.exitCode).not.toBe(0);
  }
});
