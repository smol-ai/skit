import { expect, test } from "vitest";
import { Schema } from "effect";
import { AuthoredSkillIssue } from "@smolai/skit-core/library/update";
import {
  authoredSkillIssue,
  authoredSkillIssueLines,
} from "../src/library/authored-skill-issues.js";

const roundTrip = (wire: unknown) => {
  const issue = Schema.decodeUnknownSync(AuthoredSkillIssue)(wire);
  const encoded = Schema.encodeSync(AuthoredSkillIssue)(issue);
  expect(encoded).toEqual(wire);
  expect(encoded).not.toHaveProperty("message");
  return Schema.decodeUnknownSync(AuthoredSkillIssue)(JSON.parse(JSON.stringify(encoded)));
};

test("installation warnings preserve nested failure facts and produce useful text after JSON storage", () => {
  const blocked = roundTrip({
    _tag: "UninstallBlocked",
    skill: "review",
    failure: { _tag: "UninstallConflict", path: "/agents/review" },
  });
  expect(authoredSkillIssue(blocked)).toContain("/agents/review");
  if (blocked._tag !== "UninstallBlocked") throw new Error("Wrong issue");
  expect(blocked.failure.code).toBe("CONFLICT");
  const failed = roundTrip({
    _tag: "CopyFailed",
    skill: "review",
    path: "/agents/review",
    failure: { _tag: "TreeError", reason: { _tag: "ChangedDuringRead", path: "SKILL.md" } },
  });
  expect(authoredSkillIssue(failed)).toBe(
    "review at /agents/review: Filesystem entry changed while reading: SKILL.md",
  );
  const stopped = roundTrip({
    _tag: "InstallationFailed",
    skill: "review",
    paths: ["/agents/review", "/claude/review"],
    failure: { _tag: "TreeError", reason: { _tag: "ChangedDuringRead", path: "SKILL.md" } },
  });
  expect(authoredSkillIssue(stopped)).toContain("review at /agents/review, /claude/review:");
});

test("held inputs retain removal paths, typed validation and native metadata source evidence", () => {
  const held = roundTrip({
    _tag: "InputRemovalPending",
    skill: "review",
    paths: ["skills/review/SKILL.md", "shared/rules.txt"],
  });
  expect(authoredSkillIssue(held)).toContain("Input removal awaits confirmation: shared/rules.txt");
  const validation = roundTrip({
    _tag: "ValidationHeld",
    skill: "review",
    diagnostics: [
      { code: "SKILL_FILE_MISSING", severity: "error", path: "skills/review/SKILL.md" },
    ],
  });
  expect(authoredSkillIssue(validation)).toBe(
    "review: Contained skills require a primary SKILL.md",
  );
  const metadata = roundTrip({
    _tag: "MetadataHeld",
    skill: "review",
    reports: [
      {
        harness: "codex",
        contractId: "contract",
        variant: "skill",
        status: "invalid",
        fields: { name: "review" },
        issues: [
          {
            code: "field-missing",
            field: "description",
            severity: "error",
            sourceIds: ["native-contract"],
          },
        ],
      },
    ],
  });
  expect(authoredSkillIssue(metadata)).toBe("review: codex: field-missing (description)");
  expect(authoredSkillIssueLines([held, validation, metadata])).toHaveLength(3);
});

test("descriptor and preparation failures are formatted through their owner", () => {
  const held = roundTrip({
    _tag: "DescriptorHeld",
    failure: {
      _tag: "DescriptorMalformed",
      format: "yaml",
      issue: {
        _tag: "YamlSyntax",
        errors: [{ code: "BAD_INDENT", start: 6, end: 7, line: 2, column: 1 }],
      },
    },
  });
  expect(authoredSkillIssue(held)).toContain(
    "Descriptor held: Malformed YAML SKIT Descriptor: bad indent at line 2, column 1",
  );
  const preparation = roundTrip({
    _tag: "PreparationFailed",
    skill: "review",
    failure: { _tag: "Library.SkillMaterializationInvalid", target: "../outside" },
  });
  expect(authoredSkillIssue(preparation)).toContain("../outside");
});
