/** Device-local author owners and their public vocabulary. Storage and tree writes stay private. */
export {
  AuthorSyncStateInvalid,
  type AuthorWorkspaceConflict,
  AuthorWorkspaceRootInvalid,
  type AuthorWorkspaceUnsafe,
  type AuthorWorkspaceBusy,
  type AuthorWriteNotPrepared,
  type AuthorLeaseNotHeld,
  type WorkspaceReadError,
  type AuthorWorkspace,
} from "./workspace.js";
export {
  type AuthorHistoryInvalid,
  type AuthorHistoryBusy,
  type AuthorSyncStateConflict,
  type AuthorBackupStateConflict,
  type AuthorSyncStateIllegal,
  type SavedRevision,
  type RefreshError,
  type AuthorHistory,
} from "./history.js";
export {
  AuthorWorkspaceMetadataInvalid,
  type AuthorWorkspaceAlreadyRegistered,
  InsecureOrigin,
  AuthorRemoteMetadataInvalid,
  type LocalFilesChangedDuringSync,
  type AuthorLocalPathUnchecked,
  type AuthorNormalizationTwin,
  type AuthorNonNfcPathUnsupported,
} from "./failures.js";
export { AuthorRemoteHome, AuthorVisibility } from "./remote.js";
export { scanAuthorSyncTree } from "./local-tree.js";
export type { InitSkitResult } from "./scaffold.js";
export { initSkit } from "./initialize.js";
export {
  readSkitDescriptor,
  deterministicTreeHash,
  validateSkitDirectory,
} from "../artifact/skit.js";
export { createSkitArchive } from "../artifact/archive.js";
export { type DescriptorFailure } from "../artifact/failures.js";
export type { DescriptorMalformed, ReadmeFrontmatterMissing } from "../artifact/failures.js";
export { SkitValidationDiagnostic } from "../artifact/validation-diagnostic.js";
export { InvocationMetadataGeneration } from "./invocation/generation.js";

export { authorLayer, authorWorkspaceLayer, readAuthorWorkspace } from "./operations.js";
export { syncAuthorWorkspace } from "./sync.js";
export { watchAuthorWorkspace, AuthorWatchEvent } from "./watch.js";
export { initializeAuthorWorkspace } from "./initialize.js";
export { generateAuthorInvocation } from "./invocation.js";
export { parseAuthorDestination } from "./destination.js";
export { AuthorSyncResult } from "./sync-result.js";
// The Registry side of one SKIT and the one protocol failure an adapter raises itself.
export { Moved, type Remote as SyncRemote } from "../sync/sync.js";
export { DestinationExistsWithoutHistory } from "./failures.js";

export { refreshAuthorWorkspace } from "./operations.js";
export { backupAuthorWorkspace } from "./backup.js";

export { listAuthorSkits, AuthorListIdentityError } from "./list.js";
export { deleteAuthorSkit } from "./delete.js";
export { publishAuthorWorkspace } from "./publish.js";
export { PublicationBlocked } from "./failures.js";
// Error names that inferred CLI declarations must be able to name; constructors stay internal.
export type {
  AuthorDestinationInvalid,
  AuthorDestinationMalformed,
  AuthorRemoteAlreadyExists,
  DestinationFormInvalid,
  DirectoryAlreadyInLibrary,
  NoRemoteHome,
  NotAnAuthorWorkspace,
  VisibilityNotAccepted,
} from "./failures.js";
export type { SkitValidationFailed } from "../artifact/failures.js";
