import { expect, it } from "vitest";
import { Schema } from "effect";
import {
  SetupManageSelectionReason,
  SetupManageSelectionInvalid,
  SetupDuplicateDecisionRequired,
  SetupPlanStale,
  SetupReviewFailure,
} from "@smolai/skit-core/library/setup/failures";
import { Hash } from "@smolai/skit-core/shared";
import { classifyFailure } from "../src/commands/failure-classification.js";

it("formats every refused setup selection after a JSON roundtrip without leaking reason identifiers", () => {
  for (const reason of SetupManageSelectionReason.literals) {
    const failure = new SetupManageSelectionInvalid({ skillName: "review", reason });
    const wire = Schema.encodeSync(Schema.toCodecJson(SetupReviewFailure))(failure);
    expect(wire).not.toHaveProperty("message");
    expect(wire).not.toHaveProperty("remediation");
    const stored = Schema.decodeUnknownSync(SetupReviewFailure)(JSON.parse(JSON.stringify(wire)));
    const formatted = classifyFailure(stored);
    expect(formatted.message).toContain("review");
    expect(formatted.message).not.toContain(reason);
    expect(formatted.remediation).toContain("skit setup");
  }
});

it("offers only the duplicate decisions that can apply to the reviewed copies", () => {
  for (const keepBoth of [false, true]) {
    for (const retirable of [false, true]) {
      const failure = new SetupDuplicateDecisionRequired({
        names: ["review"],
        keepBoth,
        retirable,
      });
      const formatted = classifyFailure(failure);
      const next = formatted.presentation.at(-1);
      if (next?._tag !== "Fields") throw new Error("Missing duplicate-decision instructions");
      expect(
        next.rows[0]!.value.flatMap((span) =>
          typeof span === "object" && "code" in span ? [span.code] : [],
        ),
      ).toEqual([
        "--duplicates",
        "import-only",
        ...(keepBoth ? ["keep-both"] : []),
        ...(retirable ? ["back-up-symlinks"] : []),
      ]);
    }
  }
  const formatted = classifyFailure(
    new SetupPlanStale({
      approvedPlanId: Hash.make(`sha256:${"a".repeat(64)}`),
      currentPlanId: Hash.make(`sha256:${"b".repeat(64)}`),
    }),
  );
  expect(formatted.code).toBe("CONFLICT");
  expect(formatted.message).toContain("changed after it was reviewed");
});
