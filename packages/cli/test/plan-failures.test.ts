import { failureExitCode } from "../src/commands/exit-code.js";
import { test, expect } from "vitest";
import { Schema } from "effect";
import {
  StalePlan,
  InstalledSkillWouldReplaceLink,
  InstalledSkillWouldDuplicate,
  DestinationsIncomplete,
  ManageStopped,
  SyncStopped,
} from "@smolai/skit-core/library";
import { makeOperationId } from "@smolai/skit-core/universal/consumer";
import { PlanDataFailure } from "../src/library/plan-failures.js";
import { classifyFailure } from "../src/commands/failure-classification.js";

test("a stale plan keeps its evidence path and gets frontend wording after decoding", () => {
  const failure = new StalePlan({
    reason: { _tag: "InstalledBytesChanged", kind: "reviewed", path: "/skills/review" },
  });
  const encoded = Schema.encodeSync(PlanDataFailure)(failure);
  expect(encoded).toEqual({
    _tag: "Library.StalePlan",
    reason: { _tag: "InstalledBytesChanged", kind: "reviewed", path: "/skills/review" },
  });
  const decoded = Schema.decodeUnknownSync(PlanDataFailure)(JSON.parse(JSON.stringify(encoded)));
  expect(classifyFailure(decoded)).toMatchObject({
    code: "CONFLICT",
    message: "Reviewed installed bytes changed at /skills/review",
    remediation: "Preview the change again.",
  });
});

test("duplicate presentation keeps symlink path and provenance facts", () => {
  const failure = new InstalledSkillWouldDuplicate({
    duplicates: [
      {
        name: "review",
        harness: "codex",
        canonicalPath: "/source/review/child",
        documentHash: "hash",
        aliases: [
          {
            path: "/skills/review/child",
            via: "symlink",
            linkPath: "/skills/review",
            linkTarget: "../source/review",
          },
        ],
      },
    ],
  });
  const message = classifyFailure(failure).message;
  for (const fact of [
    "review",
    "codex",
    "/source/review/child",
    "/skills/review/child",
    "/skills/review",
    "../source/review",
  ])
    expect(message).toContain(fact);
});

test("plan refusals and stopped operations keep conflict codes without core prose", () => {
  const operationId = makeOperationId();
  const reason = {
    _tag: "StepFailed" as const,
    step: 1,
    error: new StalePlan({ reason: { _tag: "SyncChanged", part: "base" } }),
  };
  const failures = [
    new InstalledSkillWouldReplaceLink({ links: ["/skills/review"] }),
    new DestinationsIncomplete({ paths: ["/skills/review"] }),
    new ManageStopped({ operationId, reason }),
    new SyncStopped({ operationId, reason }),
  ];
  for (const failure of failures) {
    const encoded = Schema.encodeSync(PlanDataFailure)(failure);
    expect(encoded).not.toHaveProperty("message");
    expect(encoded).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(PlanDataFailure)(JSON.parse(JSON.stringify(encoded)));
    const formatted = classifyFailure(decoded);
    expect(failureExitCode(formatted.code)).toBe(1);
    expect(formatted.code).toBe("CONFLICT");
    expect(formatted.message).not.toBe(failure._tag);
    expect(formatted.remediation).not.toBe("Check the reported failure and retry.");
  }
});
