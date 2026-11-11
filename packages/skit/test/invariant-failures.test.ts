import {
  AuthorWorkspaceInvariantFailed,
  WorkspaceRoot,
} from "../src/author/workspace-contracts.js";
import { assert, expect, test } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { ArchiveStreamInvalid } from "../src/artifact/archive-failure.js";
import { StepDefect } from "../src/library/recorded-failures.js";
import { StepError } from "../src/library/store/state-schema.js";
import { stepError } from "../src/library/store/step-error.js";
const Invariant = Schema.Union([AuthorWorkspaceInvariantFailed, ArchiveStreamInvalid]);
const failures = [
  new AuthorWorkspaceInvariantFailed({
    root: WorkspaceRoot.make("/author"),
    reason: { _tag: "LeaseClosed" },
  }),
  new ArchiveStreamInvalid({ path: "/work/release.zip" }),
];

it.effect.each(failures)(
  "records typed invariant facts without changing the live defect: %j",
  (failure) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.die(failure));
      if (exit._tag !== "Failure") assert.fail("Expected an invariant defect");
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(exit.cause.reasons).toHaveLength(1);
      const reason = exit.cause.reasons[0]!;
      if (!Cause.isDieReason(reason)) assert.fail("Invariant was not a defect");
      expect(reason.defect).toBe(failure);
      const recorded = stepError(failure);
      expect(recorded).toBeInstanceOf(StepDefect);
      if (recorded._tag !== "Library.StepDefect") assert.fail("Invariant was reclassified");
      expect(recorded.defect).toBe(failure);
      const wire = yield* Schema.encodeEffect(StepError)(recorded);
      expect(JSON.stringify(wire)).not.toContain('"message"');
      const stored = yield* Schema.decodeUnknownEffect(StepError)(JSON.parse(JSON.stringify(wire)));
      if (stored._tag !== "Library.StepDefect" || !Schema.is(Invariant)(stored.defect))
        assert.fail("Lost stored invariant facts");
      expect(yield* Schema.encodeEffect(Invariant)(stored.defect)).toEqual(
        yield* Schema.encodeEffect(Invariant)(failure),
      );
    }),
);

test("arbitrary native defects keep the existing exception codec", () => {
  const failure = new TypeError("Native fixture failure");
  const recorded = stepError(failure);
  if (!(recorded instanceof StepDefect)) throw new Error("Expected native defect wrapper");
  expect(recorded.defect).toBe(failure);
  const stored = Schema.decodeUnknownSync(StepError)(
    JSON.parse(JSON.stringify(Schema.encodeSync(StepError)(recorded))),
  );
  expect(stored).toMatchObject({
    _tag: "Library.StepDefect",
    defect: { name: "TypeError", message: failure.message },
  });
});
