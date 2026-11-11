import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  AuthorHistoryInvalid,
  AuthorHistoryInvalidReason,
  AuthorHistoryBusy,
  AuthorBackupStateConflict,
  AuthorSyncStateConflict,
} from "@smolai/skit-core/author/history-failures";
import { WorkspaceId, WorkspaceRoot } from "@smolai/skit-core/author/workspace-contracts";
import * as History from "@smolai/skit-core/history";
import { SkitContractError } from "@smolai/skit-core/api";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { authorHistoryReason } from "../src/author/history-failures.js";

it.effect("formats every Author history reason in the CLI from preserved facts", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.Int)("invalid"));
    const revision = History.RevisionId.make(`sha256:${"a".repeat(64)}`);
    const cases: {
      [K in AuthorHistoryInvalidReason["_tag"]]: Extract<AuthorHistoryInvalidReason, { _tag: K }>;
    } = {
      AmbiguousWorkspace: { _tag: "AmbiguousWorkspace" },
      JournalVersionInvalid: { _tag: "JournalVersionInvalid", failure },
      JournalWorkspaceMismatch: {
        _tag: "JournalWorkspaceMismatch",
        expected: "expected",
        actual: "actual",
      },
      JournalFailure: { _tag: "JournalFailure", cause: new Error("disk read failed") },
      JournalSchemaInvalid: { _tag: "JournalSchemaInvalid", failure },
      StoreFailure: {
        _tag: "StoreFailure",
        failure: new History.StoreCorrupt({
          kind: "tree",
          hash: revision,
          reason: { _tag: "ContentHashMismatch", actual: revision },
        }),
      },
      HistoryInsideWorkspace: {
        _tag: "HistoryInsideWorkspace",
        workspace: WorkspaceRoot.make("/work/review"),
        resolved: false,
      },
      JournalRedirected: { _tag: "JournalRedirected" },
      BackupParentMismatch: { _tag: "BackupParentMismatch", expected: null, actual: [] },
      InvalidTree: {
        _tag: "InvalidTree",
        issue: { _tag: "ParentNotDirectory", path: "notes/a", parent: "notes", kind: "file" },
      },
      BackupNotAncestor: {
        _tag: "BackupNotAncestor",
        acknowledged: revision,
        observation: revision,
      },
      BackupDisconnected: { _tag: "BackupDisconnected" },
    };
    for (const reason of Object.values(cases)) {
      const error = new AuthorHistoryInvalid({ path: "/state/history", reason });
      const formatted = classifyFailure(error);
      expect(formatted.code).toBe("OPERATION_FAILED");
      expect(formatted.message).toContain(authorHistoryReason(reason));
      expect(formatted.message).not.toContain("[object Object]");
      expect(formatted.remediation.length).toBeGreaterThan(20);
      expect(Object.hasOwn(error, "remediation")).toBe(false);
    }
  }),
);

it.effect("formats checkpoint, contention and API failures without a core message getter", () =>
  Effect.gen(function* () {
    const key = {
      workspaceId: WorkspaceId.make(`workspace_${"a".repeat(32)}`),
      locator: "skit://registry.example/team/review",
    };
    const checkpoint = { _tag: "Idle" as const, base: null };
    for (const error of [
      new AuthorHistoryBusy({ path: "/state/history" }),
      new AuthorSyncStateConflict({ key, found: checkpoint }),
      new AuthorBackupStateConflict({ key, found: null }),
    ]) {
      expect(classifyFailure(error).message.length).toBeGreaterThan(20);
      expect(classifyFailure(error).code).toBe(error.code);
      expect(Object.hasOwn(error, "remediation")).toBe(false);
    }
    const schemaError = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))({ name: 12 }),
    );
    const contract = new SkitContractError({
      contract: "author SKIT list response",
      reason: { _tag: "InvalidData", failure: schemaError },
    });
    expect(classifyFailure(contract).message).toContain("author SKIT list response");
    expect(classifyFailure(contract).message).toContain("name");
    const stored = Schema.decodeUnknownSync(SkitContractError)(
      Schema.encodeSync(Schema.toCodecJson(SkitContractError))(contract),
    );
    expect(classifyFailure(stored).message).toContain("name");
  }),
);
