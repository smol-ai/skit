import { AuthorDestinationRequired } from "@smolai/skit-core/author/failures";
import { failureExitCode } from "../src/commands/exit-code.js";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { AuthorFailure, PublicationBlocked } from "@smolai/skit-core/author";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { Block } from "../src/terminal/blocks.js";

test("Author failure facts survive decoding and retain conflict codes and copy-recovery guidance", () => {
  const wire = {
    _tag: "AuthorWorkspaceAlreadyRegistered",
    workspaceId: "workspace",
    at: "/author/original",
  };
  const failure = Schema.decodeUnknownSync(AuthorFailure)(wire);
  expect(Schema.encodeSync(AuthorFailure)(failure)).toEqual(wire);
  const formatted = classifyFailure(failure);
  expect(formatted).toMatchObject({ code: "CONFLICT" });
  expect(formatted.message).toContain("workspace");
  expect(formatted.message).toContain("/author/original");
  expect(formatted.remediation).toContain("only in the copy");
});

test("destination, filesystem normalization and visibility failures keep their distinct facts and codes", () => {
  for (const [wire, exitCode, word] of [
    [{ _tag: "AuthorDestinationMalformed", kind: "url" }, 1, "Invalid URL"],
    [{ _tag: "AuthorDestinationMalformed", kind: "uri-component" }, 1, "URI malformed"],
    [{ _tag: "InsecureOrigin", purpose: "authentication" }, 2, "Authentication requires HTTPS"],
    [{ _tag: "VisibilityNotAccepted", reason: "required" }, 2, "requires --visibility"],
    [{ _tag: "AuthorNormalizationTwin", path: "é.txt", nativePath: "e\u0301.txt" }, 1, "é.txt"],
  ] as const) {
    const failure = Schema.decodeUnknownSync(AuthorFailure)(wire);
    expect(Schema.encodeSync(AuthorFailure)(failure)).toEqual(wire);
    expect(failureExitCode(classifyFailure(failure).code)).toBe(exitCode);
    expect(classifyFailure(failure).message).toContain(word);
  }
});

test("publication failures retain diagnostic codes and paths instead of a joined detail", () => {
  const failure = new PublicationBlocked({
    reason: "content",
    diagnostics: [
      {
        code: "SKILL_FILE_MISSING",
        severity: "error",
        path: "review/SKILL.md",
      },
    ],
  });
  const encoded = Schema.encodeSync(AuthorFailure)(failure);
  expect(encoded).not.toHaveProperty("detail");
  expect(encoded).not.toHaveProperty("message");
  expect(encoded).not.toHaveProperty("remediation");
  expect(encoded).toMatchObject({
    diagnostics: [{ code: "SKILL_FILE_MISSING", path: "review/SKILL.md" }],
  });
  const decoded = Schema.decodeUnknownSync(AuthorFailure)(JSON.parse(JSON.stringify(encoded)));
  const described = classifyFailure(decoded);
  expect(described.code).toBe("VALIDATION_FAILED");
  expect(described.presentation[1]).toEqual(
    Block.List({
      items: [
        {
          text: ["Contained skills require a primary SKILL.md"],
          detail: [{ code: "review/SKILL.md" }],
        },
      ],
    }),
  );
});

test("first-sync guidance asks only for the missing destination and visibility", () => {
  const missingBoth = classifyFailure(new AuthorDestinationRequired({ visibilityRequired: true }));
  expect(missingBoth.remediation).toContain("--to");
  expect(missingBoth.remediation).toContain("--visibility");
  const destinationOnly = classifyFailure(
    new AuthorDestinationRequired({ visibilityRequired: false }),
  );
  expect(destinationOnly.remediation).toContain("--to");
  expect(destinationOnly.remediation).not.toContain("--visibility");
});
