import { errorMessage } from "@smolai/skit-core/shared";
import {
  WorkspaceFailure,
  SyncStateInvalidReason,
  WorkspaceUnsafeReason,
} from "@smolai/skit-core/author/workspace-contracts";
import { Match } from "effect";
import { authorFailure } from "./author-failures";
import { schemaFailure } from "./schema-failure";

const syncStateInvalidReason = (reason: SyncStateInvalidReason): string =>
  SyncStateInvalidReason.match(reason, {
    InvalidData: ({ failure }) => schemaFailure(failure),
    RemoteInvalid: ({ failure }) => authorFailure(failure).message,
    NoncanonicalDestination: () => "Noncanonical destination",
    MismatchedRemote: ({ actual, expected }) => `it names ${actual}, not ${expected}`,
  });
const workspaceUnsafeReason = (reason: WorkspaceUnsafeReason): string =>
  WorkspaceUnsafeReason.match(reason, {
    RootChanged: () => "the folder no longer resolves to itself",
    ControlNotDirectory: () => ".skit is not a real directory",
    LockNotFile: () => "the lock is not a regular file",
    LockFailed: ({ cause }) => errorMessage(cause),
    LeaseRootMismatch: () => "the workspace lease belongs to a different root",
    WatchedRootReplaced: () =>
      "the watched workspace was replaced; restart watch after checking it",
  });

export const workspaceFailure = Match.type<WorkspaceFailure>().pipe(
  Match.tagsExhaustive({
    AuthorSyncStateInvalid: ({ path, reason }) => ({
      message: `Author sync state at ${path} is invalid: ${syncStateInvalidReason(reason)}`,
      remediation: "Keep the sync state file and repair or restore it before syncing again.",
    }),
    AuthorWorkspaceConflict: ({ root }) => ({
      message: `The author workspace at ${root} changed while this command was running`,
      remediation: "Run the command again; it plans from what is there now.",
    }),
    AuthorWorkspaceRootInvalid: ({ input }) => ({
      message: `${input} is not an existing directory`,
      remediation: "Name the author workspace's folder.",
    }),
    AuthorWorkspaceUnsafe: ({ path, reason }) => ({
      message: `The author workspace cannot be locked safely at ${path}: ${workspaceUnsafeReason(reason)}`,
      remediation: "Inspect that path, move anything unexpected aside, then run the command again.",
    }),
    AuthorWorkspaceBusy: ({ root }) => ({
      message: `Another SKIT command is changing the author workspace at ${root}`,
      remediation: "Wait for it to finish, then run the command again.",
    }),
  }),
);
