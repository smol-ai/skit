import { CommandError } from "../src/commands/error-output.js";
import { failureExitCode } from "../src/commands/exit-code.js";
import { test, expect } from "vitest";
import { Schema } from "effect";
import { TreeError, TreeErrorReason } from "@smolai/skit-core/shared";
import {
  InstalledSkillFailure,
  InvalidLibraryState,
  RecoveryInvalid,
} from "@smolai/skit-core/library";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { renderFailureFrame } from "../src/commands/output-frame.js";

test.each([
  [
    { _tag: "GitCommandFailed", command: "git ls-files", exitCode: 128 },
    "git ls-files exited with 128",
  ],
  [
    {
      _tag: "GitInspectionFailed",
      issue: { _tag: "ExitCode", operation: "check-ignore", exitCode: 128, stderr: "" },
    },
    "Unable to evaluate Git ignore rules for Artifact content: Private Git ignore query exited with 128",
  ],
  [
    { _tag: "EmbeddedRepository", path: "vendor" },
    "Embedded Git repository is not valid Artifact content: vendor",
  ],
  [
    { _tag: "Submodule", path: "vendor" },
    "Registered Git submodule is not valid Artifact content: vendor",
  ],
  [{ _tag: "IgnoredRoot" }, "The SKIT root is ignored by the enclosing Git repository"],
  [{ _tag: "FullyExcludedRoot" }, "Git excludes every file in the SKIT root"],
  [{ _tag: "EscapedPath", path: "../outside" }, "Path escaped tree: ../outside"],
  [
    { _tag: "InvalidSymlink", path: "review/link" },
    "Symlinks are not valid SKIT content: review/link",
  ],
  [
    { _tag: "UnsupportedEntry", path: "review/socket" },
    "Unsupported filesystem entry: review/socket",
  ],
  [
    { _tag: "ChangedDuringRead", path: "review/SKILL.md" },
    "Filesystem entry changed while reading: review/SKILL.md",
  ],
  [
    { _tag: "CannotRetain", entryType: "Socket", path: "review/socket" },
    "Cannot back up Socket: review/socket",
  ],
] satisfies ReadonlyArray<readonly [TreeErrorReason, string]>)(
  "formats tree reason %j at the frontend",
  (reason, message) => {
    const failure = new TreeError({ reason });
    expect(classifyFailure(failure)).toMatchObject({
      code: "OPERATION_FAILED",
      message,
      remediation: "Remove or replace the reported entry in the SKIT, then retry.",
    });
    expect(Schema.encodeSync(TreeError)(failure)).toEqual({ _tag: "TreeError", reason });
  },
);

test("nested tree facts keep each wrapper's code and frontend next step", () => {
  const reason = { _tag: "UnsupportedEntry" as const, path: "review/socket" };
  const examples = [
    [
      new InstalledSkillFailure({ reason: { _tag: "InvalidTree", reason } }),
      1,
      "OPERATION_FAILED",
      "skit doctor",
    ],
    [new RecoveryInvalid({ reason: { _tag: "InvalidTree", reason } }), 1, "CONFLICT", "keep both"],
    [
      new InvalidLibraryState({
        path: "/library/originals",
        reason: { _tag: "InvalidData", tree: reason },
      }),
      1,
      "VALIDATION_FAILED",
      "skit setup",
    ],
  ] as const;
  for (const [failure, exitCode, code, next] of examples) {
    const classified = classifyFailure(failure);
    expect(failureExitCode(classified.code)).toBe(exitCode);
    expect(classified.code).toBe(code);
    expect(classified.message).toContain("Unsupported filesystem entry: review/socket");
    expect(classified.remediation).toContain(next);
    for (const format of ["human", "json"] as const) {
      const frame = renderFailureFrame(classified, { format, home: "/home", color: false });
      expect(frame.stdout).toBe("");
      expect(frame.exitCode).toBe(exitCode);
      if (format === "json") {
        const output = JSON.parse(frame.stderr);
        expect(output.error.code).toBe(code);
        expect(output.schema).toBe("skit.error.v2");
        const decoded = Schema.decodeUnknownSync(CommandError)(output.error);
        const first = decoded.cause.reasons[0];
        expect(first?._tag).toBe("Fail");
        if (first?._tag !== "Fail") throw new Error("Missing checked failure");
        expect(classifyFailure(first.error).presentation).toEqual(classified.presentation);
      }
    }
  }
});
