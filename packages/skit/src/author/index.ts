/** Device-local author owners and their public vocabulary. Storage and tree writes stay private. */
export {
  type WorkspaceRoot,
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
