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
import { libraryFailure } from "../src/library/failures";
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
