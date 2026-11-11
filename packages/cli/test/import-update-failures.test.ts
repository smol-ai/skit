import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  ImportFailure,
  ImportRequestInvalid,
  ImportRequestInvalidReason,
  InstalledSkillChanged,
} from "@smolai/skit-core/library/import/failures";
import {
  UpdateFailure,
  CollectionNotUpdatable,
  ReviewedChangeDiffers,
  GitInspectionFailed,
} from "@smolai/skit-core/library/update/failures";
import { InvalidLibraryState } from "@smolai/skit-core/library";
import { Hash } from "@smolai/skit-core/shared";
import { classifyFailure } from "../src/commands/failure-classification.js";

it.effect("keeps every import refusal structured and gives it words only at the frontend", () =>
  Effect.gen(function* () {
    const native = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Int }))({ count: "bad" }),
    );
    const expected = Hash.make(`sha256:${"a".repeat(64)}`);
    const actual = Hash.make(`sha256:${"b".repeat(64)}`);
    const cases: {
      [K in ImportRequestInvalidReason["_tag"]]: Extract<ImportRequestInvalidReason, { _tag: K }>;
    } = {
      EmptyCollection: { _tag: "EmptyCollection" },
      UnsafeSkillPath: { _tag: "UnsafeSkillPath", skill: "review", path: "../outside" },
      DuplicateSkillName: { _tag: "DuplicateSkillName", name: "review", paths: ["a", "b"] },
      OverlappingSkillPaths: {
        _tag: "OverlappingSkillPaths",
        skills: [
          { name: "a", path: "a" },
          { name: "b", path: "a/b" },
        ],
      },
      ObservedContentChanged: {
        _tag: "ObservedContentChanged",
        skill: "review",
        path: "review",
        expected,
        actual,
      },
      StateInvalid: { _tag: "StateInvalid", kind: "portable-manifest", failure: native },
      AuthoredContentInvalid: {
        _tag: "AuthoredContentInvalid",
        diagnostics: [{ code: "SKILL_FILE_MISSING", severity: "error", path: "review/SKILL.md" }],
      },
      AuthoredIdentityMissing: { _tag: "AuthoredIdentityMissing", skill: "review" },
    };
    for (const reason of Object.values(cases)) {
      const failure = new ImportRequestInvalid({ reason });
      if (failure.reason._tag === "StateInvalid") expect(failure.reason.failure).toBe(native);
      const wire = Schema.encodeSync(Schema.toCodecJson(ImportFailure))(failure);
      expect(wire).not.toHaveProperty("message");
      expect(wire).not.toHaveProperty("remediation");
      const stored = Schema.decodeUnknownSync(ImportFailure)(JSON.parse(JSON.stringify(wire)));
      expect(classifyFailure(stored).message).toContain("Cannot import Collection:");
      expect(classifyFailure(stored).remediation).toContain("correct the content");
    }
    expect(
      classifyFailure(new ImportRequestInvalid({ reason: cases.AuthoredContentInvalid })).message,
    ).toContain("review/SKILL.md");
    expect(
      classifyFailure(new ImportRequestInvalid({ reason: cases.ObservedContentChanged })).message,
    ).toContain(actual);
    expect(
      classifyFailure(new InstalledSkillChanged({ path: "/skills/review" })).message,
    ).toContain("/skills/review");
    const state = new InvalidLibraryState({
      path: "/state.json",
      reason: { _tag: "SchemaInvalid", failure: native },
    });
    expect(state.reason._tag === "SchemaInvalid" && state.reason.failure).toBe(native);
    const wire = Schema.encodeSync(Schema.toCodecJson(InvalidLibraryState))(state);
    const stored = Schema.decodeUnknownSync(InvalidLibraryState)(JSON.parse(JSON.stringify(wire)));
    expect(classifyFailure(stored).message).toContain("count");
  }),
);

it("formats every update refusal after a JSON roundtrip", () => {
  const failures = [
    new CollectionNotUpdatable({
      subject_id: "review-id",
      label: "review",
      source: "gh:team/review",
    }),
    new ReviewedChangeDiffers({ path: "/skills/review" }),
    new GitInspectionFailed({
      operation: "cat-file",
      reason: { _tag: "ExitCode", exitCode: 128, stderr: "object missing" },
    }),
  ];
  for (const failure of failures) {
    const wire = Schema.encodeSync(Schema.toCodecJson(UpdateFailure))(failure);
    expect(wire).not.toHaveProperty("message");
    expect(wire).not.toHaveProperty("remediation");
    const stored = Schema.decodeUnknownSync(UpdateFailure)(JSON.parse(JSON.stringify(wire)));
    expect(classifyFailure(stored).message.length).toBeGreaterThan(12);
    expect(classifyFailure(stored).remediation).not.toBe("Check the reported failure and retry.");
  }
  expect(classifyFailure(failures[2]).message).toContain("object missing");
});
