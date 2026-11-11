import { expect, test } from "vitest";
import { Schema } from "effect";
import { SetEnabledResult, SetEnabledIncomplete } from "@smolai/skit-core/library/enable";
import { UninstallConflict } from "@smolai/skit-core/library";
import { HomeBusy } from "@smolai/skit-core/platform";
import { DuplicateScanIncomplete } from "@smolai/skit-core/library/routing";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { renderSetEnabled } from "../src/library/enable/present.js";
import { Block } from "../src/terminal/blocks.js";

test("incomplete enable JSON retains the refused path, while the presenter writes its explanation", () => {
  const result: SetEnabledResult = {
    subject_id: "review",
    skills: ["review"],
    scope: { kind: "global" },
    action: "disable",
    changed: true,
    enabled: [],
    installed_skills: [{ destination: "agents", path: "/skills/review", status: "modified" }],
    application: {
      intent: "saved",
      revision: "a".repeat(64),
      status: "incomplete",
      failure: { code: "CONFLICT", cause: new UninstallConflict({ path: "/skills/review" }) },
    },
  };
  const encoded = Schema.encodeSync(SetEnabledResult)(result);
  expect(encoded.application.failure).toEqual({
    code: "CONFLICT",
    cause: { _tag: "UninstallConflict", path: "/skills/review" },
  });
  const decoded = Schema.decodeUnknownSync(SetEnabledResult)(JSON.parse(JSON.stringify(encoded)));
  const blocks = renderSetEnabled(decoded, true);
  expect(blocks).toContainEqual(
    Block.Status({ tone: "warn", text: ["Library choice saved for review"] }),
  );
  expect(encoded.application.revision).toBe("a".repeat(64));
  expect(JSON.stringify(blocks)).not.toContain("a".repeat(64));
  expect(blocks).toContainEqual(
    Block.Group({
      title: "Removal failed",
      children: classifyFailure(decoded.application.failure!.cause).explanation,
    }),
  );
  const incomplete = new SetEnabledIncomplete({
    results: [decoded],
    reason: "destinations",
    failure: decoded.application.failure!.cause,
  });
  const classified = classifyFailure(incomplete);
  expect(classified).toMatchObject({ code: "CONFLICT" });
  expect(classified.message).toContain("Library choice was saved");
  expect(classified.message).toContain("/skills/review");
  expect(classified.presentation).toContainEqual(
    Block.Group({
      title: "Stopped by",
      children: classifyFailure(incomplete.failure).explanation,
    }),
  );
});

test("lock and incomplete duplicate observation facts keep conflict codes and actionable wording", () => {
  expect(classifyFailure(new HomeBusy({ path: "/library/.lock" }))).toMatchObject({
    code: "CONFLICT",
    message: "Another running SKIT process holds the home writer lock at /library/.lock",
  });
  const failure = new DuplicateScanIncomplete({
    path: "/native/skills",
    reason: { _tag: "EntryLimitExceeded", limit: 4096, count: 4097 },
  });
  const encoded = Schema.encodeSync(DuplicateScanIncomplete)(failure);
  expect(encoded).toEqual({
    _tag: "DuplicateScanIncomplete",
    path: "/native/skills",
    reason: { _tag: "EntryLimitExceeded", limit: 4096, count: 4097 },
  });
  expect(classifyFailure(Schema.decodeUnknownSync(DuplicateScanIncomplete)(encoded))).toMatchObject(
    {
      code: "CONFLICT",
      message: "Skills directory exceeds the 4096-entry scan limit: /native/skills",
    },
  );
});
