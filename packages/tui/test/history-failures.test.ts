import { SetupNotRecorded } from "@smolai/skit-core/machine-settings/failures";
import { SetupManageSelectionInvalid } from "@smolai/skit-core/library/setup/failures";
import { EditImportMissing } from "@smolai/skit-core/library/edit";
import { SyncLocalChanged } from "@smolai/skit-core/library/sync";
import { InvalidUsageOptions } from "@smolai/skit-core/library/usage/contracts";
import { expect, test } from "vitest";
import { AuthorHistoryInvalid } from "@smolai/skit-core/author/history-failures";
import { SkitContractError } from "@smolai/skit-core/api";
import { StoreCorrupt } from "@smolai/skit-core/history";
import { Hash } from "@smolai/skit-core/shared";
import { libraryFailure } from "../src/library/failures";

test("a response read failure is distinct from invalid contract data", () => {
  const failure = new Error("body read failed");
  const described = libraryFailure(
    new SkitContractError({
      contract: "publish response",
      reason: { _tag: "ReadFailed", failure },
    }),
  );
  expect(described).toContain("Unable to read publish response: body read failed");
  expect(described).not.toContain("does not match");
});

test("the TUI writes history failure explanations from owner facts", () => {
  expect(
    libraryFailure(
      new AuthorHistoryInvalid({
        path: "/history/journal.sqlite",
        reason: { _tag: "JournalRedirected" },
      }),
    ),
  ).toContain("journal cannot be a symbolic link");
  expect(
    libraryFailure(
      new AuthorHistoryInvalid({
        path: "/history/journal.sqlite",
        reason: { _tag: "JournalFailure", cause: new Error("disk read failed") },
      }),
    ),
  ).toContain("disk read failed");
  expect(
    libraryFailure(
      new SkitContractError({
        contract: "Author sync tree",
        reason: {
          _tag: "InvalidTree",
          issue: { _tag: "ParentNotDirectory", path: "notes/a", parent: "notes", kind: "file" },
        },
      }),
    ),
  ).toContain("a file at notes cannot contain descendants");
  expect(
    libraryFailure(
      new StoreCorrupt({
        kind: "tree",
        hash: Hash.make(`sha256:${"a".repeat(64)}`),
        reason: { _tag: "BlobMissing", blob: Hash.make(`sha256:${"b".repeat(64)}`) },
      }),
    ),
  ).toContain("file blob");
});

test("formats settings, setup and edit failures through the TUI boundary", () => {
  const failures = [
    new SetupNotRecorded({ path: "/state/machine.json", operationId: "old-setup" }),
    new SetupManageSelectionInvalid({ skillName: "review", reason: "candidate-not-found" }),
    new EditImportMissing({ reason: { _tag: "ContentUnchanged", path: "/work/review" } }),
    new InvalidUsageOptions({ reason: { _tag: "InvalidDays", days: 0 } }),
    new SyncLocalChanged(),
  ];
  const messages = failures.map(libraryFailure);
  expect(messages[0]).toContain("old-setup");
  expect(messages[1]).toContain("no longer in the scan");
  expect(messages[2]).toContain("has not changed");
  expect(messages[3]).toContain("1 and 3650");
  expect(messages[4]).toContain("Sync again");
  expect(messages.join("\n")).not.toContain("skit ");
});
