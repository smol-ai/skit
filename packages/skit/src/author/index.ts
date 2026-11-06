/** Device-local author owners and their public vocabulary. Storage and tree writes stay private. */
export {
  type WorkspaceRoot,
  type SyncKey,
  WorkspaceId,
  Identity,
  AuthorSyncStateInvalid,
  Connecting,
  AuthorWorkspaceConflict,
  AuthorWorkspaceRootInvalid,
  type AuthorWorkspaceUnsafe,
  type AuthorWorkspaceBusy,
  type AuthorWriteNotPrepared,
  type AuthorLeaseNotHeld,
  type WorkspaceReadError,
  type WorkspaceLease,
  AuthorWorkspace,
} from "./workspace.js";
export {
  AuthorHistoryInvalid,
  type AuthorHistoryBusy,
  type AuthorSyncStateConflict,
  type AuthorBackupStateConflict,
  type AuthorSyncStateIllegal,
  type Observation,
  type CaptureError,
  AuthorHistory,
} from "./history.js";
export {
  AuthorWorkspaceMetadataInvalid,
  AuthorWorkspaceAlreadyRegistered,
  InsecureOrigin,
  AuthorDestinationInvalid,
  AuthorDestinationMalformed,
  AuthorRemoteMetadataInvalid,
  LocalFilesChangedDuringSync,
  type AuthorLocalPathNotObserved,
  type AuthorNormalizationTwin,
  type AuthorNonNfcPathUnsupported,
} from "./failures.js";
export { AuthorRemoteHome, AuthorVisibility, decodeUrl, normalizeRemote } from "./remote.js";
export { scanAuthorSyncTree } from "./local-tree.js";
export { type InitSkitResult, initSkit } from "./scaffold.js";
export {
  readSkitDescriptor,
  deterministicTreeHash,
  validateSkitDirectory,
} from "../artifact/skit.js";
export { createSkitArchive } from "../artifact/archive.js";
export { type DescriptorFailure, SkitValidationFailed } from "../artifact/failures.js";
export type { DescriptorMalformed, ReadmeFrontmatterMissing } from "../artifact/failures.js";
export { SkitValidationDiagnostic } from "../artifact/validation-diagnostic.js";
export {
  generateInvocationMetadata,
  InvocationMetadataGeneration,
  type InvocationMetadataGenerationFailure,
} from "./invocation/generation.js";
export { mergeAuthorTree, conflictKind } from "./merge/files.js";
