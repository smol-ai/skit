import { describeFailure } from "../terminal/failure.js";
import {
  AuthorHistoryFailure,
  AuthorHistoryInvalidReason,
} from "@smolai/skit-core/author/history-failures";
import { Match } from "effect";
import { errorMessage } from "@smolai/skit-core/shared";
import { schemaFailure } from "../platform/schema-failure.js";
import { historyStoreFailure, treePathIssue } from "../platform/history-failures.js";

export const authorHistoryReason = (reason: AuthorHistoryInvalidReason): string =>
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
      "the acknowledged backup is not an ancestor of this workspace's current Revision",
    BackupDisconnected: () => "backup requires a connected workspace",
  });

export const authorHistoryFailure = Match.type<AuthorHistoryFailure>().pipe(
  Match.tagsExhaustive({
    AuthorHistoryInvalid: ({ path, reason }) =>
      describeFailure({
        summary: [
          `${path === "history" ? "Author history" : `Author history at ${path}`} is unusable: ${authorHistoryReason(reason)}`,
        ],
        next:
          reason._tag === "HistoryInsideWorkspace"
            ? [
                "Choose a SKIT state directory outside the Author Workspace with --home, then retry.",
              ]
            : reason._tag === "BackupDisconnected"
              ? ["Connect this Author Workspace before backing it up."]
              : ["Keep the history files and resolve the storage problem before syncing again."],
      }),
    AuthorHistoryBusy: ({ path }) =>
      describeFailure({
        summary: [`Author history at ${path} is busy with another recording`],
        next: ["Retry after the other recording completes."],
      }),
    AuthorSyncStateConflict: ({ key }) =>
      describeFailure({
        summary: [`The sync checkpoint for ${key.locator} changed while this sync was running`],
        next: [
          "Run ",
          { code: "skit author sync" },
          " again; it plans from the checkpoint saved now.",
        ],
      }),
    AuthorBackupStateConflict: ({ key }) =>
      describeFailure({
        summary: [`The backup checkpoint for ${key.locator} changed while this backup was running`],
        next: [
          "Run ",
          { code: "skit author sync" },
          " again; it resumes from the acknowledged Revision.",
        ],
      }),
  }),
);
