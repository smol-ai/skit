import { expect, test } from "vitest";
import { Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { SkillsShUpdateReason } from "@smolai/skit-core/library";
import { GitInspectionFailed } from "@smolai/skit-core/library/update/failures";
import { CheckResult } from "../src/library/check/output.js";
import { renderCheck } from "../src/library/check/present.js";
import { Block } from "../src/terminal/blocks.js";
import { result } from "../src/commands/result.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/commands/output-frame.js";

const checked = (reason: SkillsShUpdateReason): CheckResult => [
  {
    subject_id: "review-tools",
    subject_kind: "collection",
    label: "review-tools",
    collection_versions: [],
    unresolved_skill_selections: 0,
    source_status: "current",
    has_imports: true,
    skills_sh: {
      checked_at: "2026-11-11T00:00:00.000Z",
      members: [
        {
          skill_name: "review",
          status: "unverifiable",
          reason,
        },
      ],
    },
  },
];

test("check explains exactly which lock fields are missing while JSON retains facts", () => {
  const data = checked({ _tag: "LockIncomplete", missing: ["skill-path"] });
  expect(renderCheck(data)).toContainEqual(
    Block.Group({
      title: "review",
      children: [
        Block.Note({ text: ["Could not verify updates"] }),
        Block.Note({ text: ["The lock file is missing the Skill path."] }),
      ],
    }),
  );
  const json = renderResultFrame(result("check", data), {
    ...defaultTerminalEnvironment,
    format: "json",
  });
  expect(JSON.parse(json.stdout).data[0].skills_sh.members[0].reason).toEqual({
    _tag: "LockIncomplete",
    missing: ["skill-path"],
  });
});

test("native mirror and Git process failures survive the check contract boundary", () => {
  const failure = systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "makeDirectory",
    pathOrDescriptor: "/library/cache",
  });
  const reasons: SkillsShUpdateReason[] = [
    { _tag: "OriginalBytesUnavailable", failures: [failure] },
    { _tag: "MirrorUnavailable", failure },
    {
      _tag: "GitEvidenceUnavailable",
      failure: new GitInspectionFailed({
        operation: "ls-tree",
        reason: { _tag: "ProcessFailed", failure },
      }),
    },
  ];
  for (const reason of reasons) {
    const data = checked(reason);
    expect(data[0]?.skills_sh?.members[0]?.reason).toBe(reason);
    const encoded = Schema.encodeSync(CheckResult)(data);
    const decoded = Schema.decodeSync(CheckResult)(encoded);
    expect(Schema.encodeSync(CheckResult)(decoded)).toEqual(encoded);
    expect(renderCheck(decoded)).toEqual(renderCheck(data));
  }
});

test("check rejects arbitrary prose in its machine reason", () => {
  expect(() =>
    Schema.decodeUnknownSync(CheckResult)([
      {
        ...checked({ _tag: "GitSourceMissing" })[0],
        skills_sh: {
          checked_at: "now",
          members: [
            { skill_name: "review", status: "unverifiable", reason: "could not reach Git source" },
          ],
        },
      },
    ]),
  ).toThrow();
});
