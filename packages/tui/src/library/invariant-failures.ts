import { LibraryInvariantFailed, LibraryInvariantReason } from "@smolai/skit-core/library";
import {
  AuthorWorkspaceInvariantFailed,
  AuthorWorkspaceInvariantReason,
} from "@smolai/skit-core/author/workspace-contracts";
import { Schema } from "effect";
import { ArchiveStreamInvalid } from "@smolai/skit-core/universal/consumer";

export const invariantFailure = (error: unknown): string | undefined => {
  if (Schema.is(AuthorWorkspaceInvariantFailed)(error))
    return AuthorWorkspaceInvariantReason.match(error.reason, {
      LeaseClosed: () =>
        `An author operation used the workspace lease after it closed: ${error.root}`,
      WriteNotOwned: () =>
        `An author write used another workspace lease's checkpoint: ${error.root}`,
      CheckpointChanged: () =>
        `An author write used a checkpoint after another state change: ${error.root}`,
      WriteAlreadyUsed: () => `An author write operation was applied more than once: ${error.root}`,
      TreesDiffer: () =>
        `An author write supplied files outside its saved checkpoint: ${error.root}`,
    });
  if (Schema.is(LibraryInvariantFailed)(error)) {
    const summary = LibraryInvariantReason.match(error.reason, {
      DatabaseWriteInsideRead: () => "A Library write started inside a read transaction",
      DatabaseWriterLockMissing: () => "A Library write started without the writer lock",
      ImportInsideTransaction: () => "A Library import started inside a database transaction",
    });
    return `${summary}: ${error.path}`;
  }
  if (Schema.is(ArchiveStreamInvalid)(error))
    return `ZIP writer supplied an unsupported output stream for ${error.path}`;
  return undefined;
};
