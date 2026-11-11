import { expect, test } from "vitest";
import { Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { LibraryChanged } from "@smolai/skit-core/library";
import { SyncEnablementIssue, SyncIssue } from "@smolai/skit-core/library/sync";
import { makeSkillId } from "@smolai/skit-core/universal/consumer";
import { syncIssue } from "../src/library/sync/present.js";
import { Block, renderBlocks } from "../src/terminal/blocks.js";

const id = makeSkillId();
const scanFailure = systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "readDirectory",
  pathOrDescriptor: "/skills/private",
});
const installFailure = new LibraryChanged({ path: "/home/state.json" });
const cases = {
  SelectionMissing: { _tag: "SelectionMissing", selection: { skill: id } },
  DuplicateScanFailed: { _tag: "DuplicateScanFailed", failure: scanFailure },
  ExistingCopy: {
    _tag: "ExistingCopy",
    copy: {
      name: "review",
      harness: "codex",
      canonicalPath: "/source/review",
      aliases: [
        {
          path: "/skills/review",
          via: "symlink",
          linkPath: "/skills/review",
          linkTarget: "/source/review",
        },
      ],
      documentHash: "sha256:fixture",
    },
  },
  InstallationFailed: { _tag: "InstallationFailed", failure: installFailure },
  InstalledFolderConflicted: {
    _tag: "InstalledFolderConflicted",
    path: "/skills/review",
    conflicts: [
      { _tag: "MarkerMissing" },
      {
        _tag: "ContentChanged",
        expected: `sha256:${"a".repeat(64)}`,
        actual: `sha256:${"b".repeat(64)}`,
        baseline: "library",
      },
    ],
  },
} as const satisfies Record<SyncEnablementIssue["_tag"], SyncEnablementIssue>;

test.each(Object.values(cases))(
  "$_tag facts survive JSON and retain the same semantic presentation",
  (issue) => {
    const wire = Schema.encodeSync(Schema.toCodecJson(SyncIssue))(issue);
    const decoded = Schema.decodeUnknownSync(SyncIssue)(JSON.parse(JSON.stringify(wire)));
    expect(syncIssue(decoded)).toEqual(syncIssue(issue));
    expect(Schema.is(SyncIssue)("an English issue")).toBe(false);
  },
);

test("native failures remain intact live, and stored nested facts keep their owner-specific fields", () => {
  expect(cases.DuplicateScanFailed.failure).toBe(scanFailure);
  expect(cases.InstallationFailed.failure).toBe(installFailure);
  const encoded = Schema.encodeSync(Schema.toCodecJson(SyncIssue))(cases.InstallationFailed);
  expect(encoded).toMatchObject({
    _tag: "InstallationFailed",
    failure: { _tag: "LibraryChanged", path: "/home/state.json" },
  });
  expect(syncIssue(cases.ExistingCopy)).toMatchObject({
    detail: ["Resolves to ", { code: "/source/review" }, expect.any(String)],
  });
  const rendered = renderBlocks(
    [Block.List({ items: [syncIssue(cases.InstalledFolderConflicted)] })],
    { color: false, width: 100 },
  );
  expect(rendered).toContain("no SKIT ownership marker");
  expect(rendered.replace(/\s+/g, " ")).toContain(
    "files differ from the content recorded in the Library",
  );
  expect(rendered).not.toContain("content or ownership");
  expect(rendered).not.toContain("MarkerMissing");
});

test("old folder records without conflict facts are reported honestly", () => {
  const item = syncIssue({
    _tag: "InstalledFolderConflicted",
    path: "/skills/review",
    conflicts: [],
  });
  expect(item.detail).toEqual([
    "The saved record has no conflict details. Run ",
    { code: "skit doctor" },
    " to check the folder again.",
  ]);
});
