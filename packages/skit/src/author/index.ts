/** Device-local author owners and their public vocabulary. Storage and tree writes stay private. */
export {
  Identity,
  AuthorSyncStateInvalid,
  AuthorWorkspaceConflict,
  AuthorWorkspaceRootInvalid,
  type AuthorWorkspaceUnsafe,
  type AuthorWorkspaceBusy,
  type AuthorWriteNotPrepared,
  type AuthorLeaseNotHeld,
  type WorkspaceReadError,
  type AuthorWorkspace,
} from "./workspace.js";
export {
  AuthorHistoryInvalid,
  type AuthorHistoryBusy,
  type AuthorSyncStateConflict,
  type AuthorBackupStateConflict,
  type AuthorSyncStateIllegal,
  type Observation,
  type CaptureError,
  type AuthorHistory,
} from "./history.js";
export {
  AuthorWorkspaceMetadataInvalid,
  AuthorWorkspaceAlreadyRegistered,
  InsecureOrigin,
  AuthorRemoteMetadataInvalid,
  LocalFilesChangedDuringSync,
  type AuthorLocalPathNotObserved,
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
export { initializeAuthorWorkspace } from "./initialize.js";
export { removeAuthorCollection } from "./remove.js";
export { generateAuthorInvocation } from "./invocation.js";
export { parseAuthorDestination } from "./destination.js";
export { AuthorSyncResult } from "./sync-result.js";
export type { AuthorRegistry } from "./transport.js";
// The Registry side of one SKIT and the one protocol failure an adapter raises itself.
export { Moved, type Remote as SyncRemote } from "../sync/sync.js";
export { DestinationExistsWithoutHistory } from "./failures.js";

export { captureAuthorWorkspace } from "./operations.js";
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
  AuthorWorkspaceRemovalUnfinished,
  DestinationFormInvalid,
  DirectoryAlreadyInLibrary,
  NoRemoteHome,
  VisibilityNotAccepted,
} from "./failures.js";
export type { SkitValidationFailed } from "../artifact/failures.js";
