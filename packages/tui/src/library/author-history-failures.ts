import {
  AuthorHistoryFailure,
  AuthorHistoryInvalidReason,
} from "@smolai/skit-core/author/history-failures";
import { Match } from "effect";
import { errorMessage } from "@smolai/skit-core/shared";
import { schemaFailure } from "./schema-failure";
import { historyStoreFailure, treePathIssue } from "./history-store-failures";

const authorHistoryReason = (reason: AuthorHistoryInvalidReason): string =>
  AuthorHistoryInvalidReason.match(reason, {
    AmbiguousWorkspace: () => "workspace identity is ambiguous at this path",
    JournalVersionInvalid: ({ failure }) => `unsupported journal schema: ${schemaFailure(failure)}`,
    JournalWorkspaceMismatch: ({ expected, actual }) =>
      `journal workspace ${actual} does not match ${expected}`,
    JournalFailure: ({ cause }) => errorMessage(cause),
    JournalSchemaInvalid: ({ failure }) => schemaFailure(failure),
    StoreFailure: ({ failure }) => historyStoreFailure(failure).message,
    HistoryInsideWorkspace: ({ workspace, resolved }) =>
      resolved
        ? `history resolves inside the Author Workspace at ${workspace}`
        : `history is inside the Author Workspace at ${workspace}`,
    JournalRedirected: () => "journal cannot be a symbolic link",
    BackupParentMismatch: () =>
      "a backup checkpoint must advance one saved revision without skipping its parent",
    InvalidTree: ({ issue }) => treePathIssue(issue),
    BackupNotAncestor: () =>
      "the acknowledged backup is not an ancestor of this workspace's revision",
    BackupDisconnected: () => "backup requires a connected workspace",
  });

export const authorHistoryFailure = Match.type<AuthorHistoryFailure>().pipe(
  Match.tagsExhaustive({
    AuthorHistoryInvalid: ({ path, reason }) => ({
      message: `${path === "history" ? "Author history" : `Author history at ${path}`} is unusable: ${authorHistoryReason(reason)}`,
      remediation:
        reason._tag === "HistoryInsideWorkspace"
          ? "Choose a SKIT state directory outside the Author Workspace with --home, then retry."
          : reason._tag === "BackupDisconnected"
            ? "Connect this Author Workspace before backing it up."
            : "Keep the history files and resolve the storage problem before syncing again.",
    }),
    AuthorHistoryBusy: ({ path }) => ({
      message: `Author history at ${path} is busy with another recording`,
      remediation: "Retry after the other recording completes.",
    }),
    AuthorSyncStateConflict: ({ key }) => ({
      message: `The sync checkpoint for ${key.locator} changed while this sync was running`,
      remediation: "Sync again; it plans from the checkpoint saved now.",
    }),
    AuthorBackupStateConflict: ({ key }) => ({
      message: `The backup checkpoint for ${key.locator} changed while this backup was running`,
      remediation: "Sync again; it resumes from the acknowledged revision.",
    }),
  }),
);
