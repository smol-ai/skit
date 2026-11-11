import { WorkspaceFailure } from "@smolai/skit-core/author/workspace-contracts";
import { AuthorFailure } from "@smolai/skit-core/author/failures";
import { DescriptorMalformed } from "@smolai/skit-core/universal/consumer";
import { HomeBusy } from "@smolai/skit-core/platform";
import { libraryFailure } from "../src/library/failures";
import { expect, test } from "vitest";
import { ImportContentInvalid } from "@smolai/skit-core/library";
import { HarnessMetadataInvalid } from "@smolai/skit-core/harnesses";
import { Result, Schema } from "effect";
import { invocationFailure } from "../src/library/invocation-failure";
import { libraryRows } from "../src/shell/presentation";
import { type LibrarySkillRow } from "@smolai/skit-core/library/session";
import { TreeError } from "@smolai/skit-core/shared";

test.each([
  [
    {
      _tag: "NormalizedPathCollision",
      path: "caf\u00e9.txt",
      firstPath: "caf\u00e9.txt",
      secondPath: "cafe\u0301.txt",
    },
    'Paths "caf\\u00e9.txt" and "cafe\\u0301.txt"',
  ],
  [
    { _tag: "NativeIdentityMissing", path: ".", entryType: "Directory" },
    "Cannot record the filesystem identity",
  ],
  [
    { _tag: "RootNotDirectory", path: ".", entryType: "SymbolicLink" },
    "Tree root must be a directory; found a symbolic link",
  ],
] as const)(
  "tree facts retain their precise explanation across JSON: %j",
  (reason, explanation) => {
    const failure = new TreeError({ reason });
    const stored = Schema.decodeUnknownSync(TreeError)(
      JSON.parse(JSON.stringify(Schema.encodeSync(TreeError)(failure))),
    );
    expect(invocationFailure(failure)).toContain(explanation);
    expect(invocationFailure(stored)).toBe(invocationFailure(failure));
  },
);

test("unavailable invocation preferences present their source facts in TUI rows", () => {
  const failure = new ImportContentInvalid({
    reason: { _tag: "ContentChanged", kind: "collection", skillName: "review" },
  });
  const row: LibrarySkillRow = {
    name: "review",
    skillId: "skill",
    skillVersionId: "version",
    collectionId: "collection",
    heading: "review",
    source: null,
    revision: null,
    source_updated_at: null,
    imported_at: null,
    authorInvocation: Result.fail(failure),
    invocationFailure: failure,
    scopes: [],
  };
  const item = libraryRows([row], "collection").find((item) => item.kind === "library-skill");
  expect(item?.status).toBe("warning");
  expect(item?.evidence).toContain("Author preference unavailable: Stored copy for review changed");
  expect(
    invocationFailure(
      new HarnessMetadataInvalid({ path: "/skills/review/SKILL.md", kind: "SKILL.md frontmatter" }),
    ),
  ).toBe("Invalid SKILL.md frontmatter: /skills/review/SKILL.md");
});

test("Library opening failures keep their path and next step at the TUI boundary", () => {
  expect(libraryFailure(new HomeBusy({ path: "/library/.lock" }))).toContain(
    "/library/.lock. Wait for it to finish",
  );
});

test("descriptor facts produce useful field diagnostics in the TUI", () => {
  const error = new DescriptorMalformed({
    format: "json",
    issue: {
      _tag: "Schema",
      failure: {
        _tag: "StoredSchemaFailure",
        issues: [
          {
            path: ["skills", 0, "path"],
            reason: {
              _tag: "InvalidValue",
              check: { id: "skit/schema/path-relative", payload: null },
            },
          },
        ],
      },
    },
  });
  expect(invocationFailure(error)).toContain(
    'Path must be safe and relative at ["skills"][0]["path"]',
  );
});

test("Author workspace failures keep copy recovery facts visible in the TUI", () => {
  const error = Schema.decodeUnknownSync(AuthorFailure)({
    _tag: "AuthorWorkspaceAlreadyRegistered",
    workspaceId: "workspace",
    at: "/author/original",
  });
  const text = libraryFailure(error);
  expect(text).toContain("workspace");
  expect(text).toContain("/author/original");
  expect(text).toContain("only in the copy");
});

test("TUI publication refusal formats structured validation facts", () => {
  const error = Schema.decodeUnknownSync(AuthorFailure)({
    _tag: "PublicationBlocked",
    reason: "content",
    diagnostics: [
      {
        code: "INVOCATION_METADATA_MISMATCH",
        severity: "error",
        path: "skills/review/SKILL.md",
        issue: {
          skill: "review",
          harness: "claude-code",
          path: "skills/review/SKILL.md",
          field: "disable-model-invocation",
          policy: "explicit",
          expected: "explicit",
        },
      },
    ],
  });
  const text = libraryFailure(error);
  expect(text).toContain("must set disable-model-invocation: true");
  expect(text).toContain("skit author invocation");
});

test("workspace lock failure facts retain their path and recovery guidance in the TUI", () => {
  const error = Schema.decodeUnknownSync(WorkspaceFailure)({
    _tag: "AuthorWorkspaceUnsafe",
    path: "/author/.skit/lock.sqlite",
    reason: {
      _tag: "LockFailed",
      cause: {
        error: { name: "Error", message: "file is not a database" },
        properties: { code: "ERR_SQLITE_ERROR", errcode: 26 },
      },
    },
  });
  expect(libraryFailure(error)).toContain("/author/.skit/lock.sqlite: file is not a database");
  expect(libraryFailure(error)).toContain("move anything unexpected aside");
});
