import { failureExitCode } from "../src/commands/exit-code.js";
import { test, expect } from "vitest";
import { Schema } from "effect";
import {
  UnsafeInstalledSkillName,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  InstalledSkillFileMissing,
  InstalledSkillFailure,
  InstalledSkillInvalid,
  UninstallConflict,
} from "@smolai/skit-core/library";
import { InstalledSkillsDataFailure } from "../src/library/installed-skill-failures.js";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { installedSkillChangeReason } from "../src/library/presentation/installed-skill-changes.js";

test.each([
  [
    new InstalledSkillInvalid({ reason: { _tag: "ManageTargetChanged", path: "/skills/review" } }),
    1,
    "folder to manage changed after preview",
  ],
  [
    new InstalledSkillInvalid({
      reason: { _tag: "ManageContentMismatch", path: "/skills/review" },
    }),
    1,
    "does not match the Skill Version in the Library",
  ],
  [
    new InstalledSkillFailure({ reason: { _tag: "SharedPathOutsideSkill", path: "../outside" } }),
    1,
    "../outside",
  ],
  [
    new InstalledSkillFailure({ reason: { _tag: "VersionMissing", kind: "former" } }),
    1,
    "Former installed skill",
  ],
  [
    new InstalledSkillInvalid({ reason: { _tag: "InputsChanged", skillName: "review" } }),
    1,
    "review",
  ],
  [new UninstallConflict({ path: "/skills/review" }), 1, "/skills/review"],
  [new UnsafeInstalledSkillName({ skillName: "../outside" }), 2, "../outside"],
  [new UnsafeInstalledSkillBackups({ path: "/backup" }), 1, "/backup"],
  [new SharedTargetCollision({ target: "/skills" }), 1, "/skills"],
  [new InstalledPathCollision({ path: "/skills/review", kind: "file" }), 1, "file collision"],
  [
    new InstalledPathCollision({ path: "/skills/review", kind: "file-or-directory" }),
    1,
    "file/directory collision",
  ],
  [new SkillsDirectoryNotWritable({ root: "/skills" }), 1, "/skills"],
  [new OwnershipMarkerDisagrees({ skillId: "review", target: "/skills/review" }), 1, "review"],
  [
    new InstalledSkillFileMissing({ path: "/skills/review/SKILL.md" }),
    1,
    "/skills/review/SKILL.md",
  ],
] as const)("stored %j keeps its code and gets CLI wording", (failure, exitCode, detail) => {
  const fields = Schema.encodeSync(InstalledSkillsDataFailure)(failure);
  expect(fields).not.toHaveProperty("message");
  expect(fields).not.toHaveProperty("remediation");
  const decoded = Schema.decodeUnknownSync(InstalledSkillsDataFailure)(
    JSON.parse(JSON.stringify(fields)),
  );
  const result = classifyFailure(decoded);
  expect(result.code).toBe(failure.code);
  expect(failureExitCode(result.code)).toBe(exitCode);
  expect(result.message).toContain(detail);
  expect(result.message).not.toBe(failure._tag);
  expect(result.remediation).not.toBe("Check the reported failure and retry.");
});

test("a protected preview formats its recorded source error instead of the bare tag", () => {
  expect(
    installedSkillChangeReason({
      _tag: "PlanningFailed",
      error: new InstalledSkillInvalid({ reason: { _tag: "InputsChanged", skillName: "review" } }),
    }),
  ).toBe(
    "The Library cannot plan its installed copies: Skill review inputs in the Library changed",
  );
});

test("permission and marker failures keep the concrete CLI recovery guidance", () => {
  expect(
    classifyFailure(new SkillsDirectoryNotWritable({ root: "/skills" })).remediation,
  ).toContain("write access to /skills");
  expect(
    classifyFailure(new OwnershipMarkerDisagrees({ skillId: "review", target: "/skills/review" }))
      .remediation,
  ).toContain("skit doctor");
  expect(
    classifyFailure(new InstalledSkillFileMissing({ path: "/skills/review/SKILL.md" })).remediation,
  ).toContain("skit doctor");
});
