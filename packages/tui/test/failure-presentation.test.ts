import { InvalidLibraryState, LibraryChanged } from "@smolai/skit-core/library";
import {
  AuthorWorkspaceInvariantFailed,
  WorkspaceRoot,
} from "@smolai/skit-core/author/workspace-contracts";
import { RestoreInvalid } from "@smolai/skit-core/library/restore/failures";
import { RegistryNotConfigured } from "@smolai/skit-core/library/source/failures";
import { AuthorDestinationRequired } from "@smolai/skit-core/author/failures";
import { expect, test } from "vitest";
import {
  PluginManifestInvalid,
  PluginSkillConflict,
} from "@smolai/skit-core/library/source/plugin-failures";
import { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";
import { PnpmSkillManaged } from "@smolai/skit-core/installed-skills/pnpm-failures";
import { ImportRequestInvalid } from "@smolai/skit-core/library/import/failures";
import { CollectionNotUpdatable } from "@smolai/skit-core/library/update/failures";
import { libraryFailure, libraryReadFailure } from "../src/library/failures";
import { SkitValidationFailed } from "@smolai/skit-core/author";
import { Schema } from "effect";

test("the TUI explains structured archive diagnostics after JSON storage", () => {
  const original = new SkitValidationFailed({
    diagnostics: [
      {
        code: "EXAMPLE_SKILL_UNKNOWN",
        severity: "error",
        path: "examples/review/case.yaml",
        skill: "review",
      },
    ],
  });
  const stored = Schema.decodeUnknownSync(SkitValidationFailed)(
    JSON.parse(JSON.stringify(Schema.encodeSync(SkitValidationFailed)(original))),
  );
  expect(libraryFailure(stored)).toContain(
    "examples/review/case.yaml: Example references undeclared skill review",
  );
  expect(libraryFailure(stored)).not.toContain("EXAMPLE_SKILL_UNKNOWN");
});

test("the TUI formats plugin, installer, import and update failures from their facts", () => {
  const cases = [
    [
      new AuthorWorkspaceInvariantFailed({
        root: WorkspaceRoot.make("/author"),
        reason: { _tag: "LeaseClosed" },
      }),
      "workspace lease after it closed",
    ],
    [
      new RestoreInvalid({
        reason: { _tag: "CopyNotAvailable", hash: `sha256:${"a".repeat(64)}` },
      }),
      "Collection Version",
    ],
    [new RegistryNotConfigured(), "Choose a Registry URL"],
    [
      new AuthorDestinationRequired({ visibilityRequired: true }),
      "destination Namespace and SKIT, and its visibility",
    ],
    [
      new PluginManifestInvalid({
        path: "/source/plugin.json",
        reason: { _tag: "LinkEscape", root: "/source", target: "/outside" },
      }),
      "Link target /outside escapes",
    ],
    [
      new PluginSkillConflict({
        skillName: "review",
        paths: ["a/review", "b/review"],
        directories: ["a", "b"],
        locators: ["/a/review", "/b/review"],
      }),
      "Available selections: /a/review; /b/review",
    ],
    [
      new DedicatedInstallerRequired({
        sourceCoordinate: "github:example/tool",
        displayName: "Tool",
        command: "npx tool install",
        documentationUrl: "https://example.test/install",
      }),
      "npx tool install",
    ],
    [
      new PnpmSkillManaged({ path: "/skills/review", package: "@acme/review" }),
      "managed by pnpm (@acme/review)",
    ],
    [
      new ImportRequestInvalid({
        reason: { _tag: "DuplicateSkillName", name: "review", paths: ["a", "b"] },
      }),
      'duplicate Skill name "review" at "a" and "b"',
    ],
    [
      new CollectionNotUpdatable({
        subject_id: "review-id",
        label: "review",
        source: "/source/review",
      }),
      "Add /source/review again to update it.",
    ],
  ] as const;
  for (const [failure, expected] of cases) {
    const text = libraryFailure(failure);
    expect(text).toContain(expected);
    expect(text).not.toContain("skit add");
    expect(text).not.toContain("[object Object]");
  }
});

test("database failures explain recovery without resetting only the legacy state file", () => {
  const path = "/library/library.sqlite";
  for (const reason of [
    { _tag: "DatabaseIntegrityInvalid", databasePath: path, result: ["corrupt"] },
    { _tag: "OperationStateMissing", databasePath: path },
  ] as const) {
    const rendered = libraryFailure(new InvalidLibraryState({ path, reason }));
    expect(rendered).toContain("entire Library home");
    expect(rendered).toContain("-wal/-shm");
    expect(rendered).toContain("verified complete backup");
  }
  expect(
    libraryFailure(
      new InvalidLibraryState({
        path,
        reason: {
          _tag: "NewerDatabaseMigration",
          databasePath: path,
          migration: 99,
          supported: 10,
        },
      }),
    ),
  ).toContain("build that supports this migration");
});

test("retains typed inventory row evidence across the TUI failure codec", () => {
  const failure = new InvalidLibraryState({
    path: "/state/library.sqlite",
    reason: { _tag: "InventoryRowsInvalid", table: "library_unmanaged_paths", position: 2 },
  });
  const codec = Schema.toCodecJson(InvalidLibraryState);
  const data = Schema.encodeSync(codec)(failure);
  expect(Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(data))).reason).toEqual(
    failure.reason,
  );
});

test("database damage, refused edits and transaction mistakes have distinct actions", () => {
  const path = "/library/library.sqlite";
  const action = (reason: InvalidLibraryState["reason"]) => {
    const error = new InvalidLibraryState({ path, reason });
    return libraryReadFailure(error)?.remediation;
  };
  const backup = action({ _tag: "DatabaseEmpty" });
  const report = action({ _tag: "DatabaseWriteInsideRead" });
  const review = action({ _tag: "UndoFieldChanged", field: "unmanaged" });
  expect(action({ _tag: "DatabaseWriterLockMissing" })).toEqual(report);
  expect(action({ _tag: "EnabledSubjectMissing", subject: "skill", id: "skill" })).toEqual(review);
  expect(new Set([backup, report, review].map((value) => JSON.stringify(value))).size).toBe(3);
  expect(libraryReadFailure(new LibraryChanged({ path }))?.remediation).toBeDefined();
});
