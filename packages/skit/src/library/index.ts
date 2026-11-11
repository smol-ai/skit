/** Public Library owner operations and read models. Storage and writers stay private. */
export {
  Service,
  layer,
  Approval,
  StalePlan,
  SourceRestoreInvalid,
  isRemoteSyncPlan,
  type Interface,
  type Snapshot,
  type Outcome,
  type FolderEvidence,
  type LinkEvidence,
  type InstalledSkillResult,
  type RemoveOutcome,
  type SetupResult,
} from "./library.js";
export { ImportContentInvalid, ImportContentInvalidReason } from "./failures.js";
export { InvalidLibraryState, InvalidLibraryStateReason } from "./failures.js";
export {
  UninstallConflict,
  UnsafeInstalledSkillName,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  InstalledSkillFileMissing,
} from "../installed-skills/failures.js";
export { InstallScope } from "./scope.js";
export { InstallDestination } from "../installed-skills/destination.js";
export { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
// Current snapshot data codec; file access and historical migration stay private to Library.
export { LibraryState } from "./library-state.js";
export { LibraryAuditEvent } from "./audit/audit-log.js";
export {
  RecoveryInspection,
  RecoveryFactReason,
  UndoConflict,
  UndoScope,
} from "./recovery-facts.js";
export { OperationStopped } from "./store/operation-failures.js";
export type { RestoreInvalid } from "./library.js";
export type { RestoreProgress, RestorePhase } from "./restore-progress.js";
// Canonical result and failure names keep consumer declarations on the owner API.
export type { LibraryLayerError, LibraryStateReadError } from "./library.js";
export type {
  ImportRequestInvalid,
  ImportRequest,
  AuthoredImport,
  EditImport,
  ImportedCollection,
  InstalledSkillChanged,
  ImportedEdit,
} from "./import-collection.js";
export {
  AddNoSkills,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  SetupImportInvalid,
} from "./failures.js";
export type { LibraryAuditInvalid } from "./audit/audit-log.js";
export { InvalidIntent, SetEnabledInvalid } from "./enabled-plan.js";
export { ManageSelectionInvalid, SetupStepsInvalid } from "./failures.js";
export {
  InstalledSkillInvalid,
  InstalledSkillInvalidReason,
} from "./installation/install-enabled.js";
export { CollectionRemovalMissing, SkillRemovalRequiresCollection } from "./installation/remove.js";
export { RecoveryInvalid } from "./store/operation-failures.js";

export {
  AcceptanceIncomplete,
  ContentAddressCollision,
  SecurityFindingAbsent,
  UnknownInstalledSkill,
  LibraryChanged,
} from "./failures.js";

export { InstalledSkillFailure, InstalledSkillFailureReason } from "../installed-skills/files.js";

export { InstalledSkillChangeReason } from "./installed-skill-review.js";

export {
  StalePlanReason,
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
} from "./plan-failures.js";

export { ManageStopped } from "./internal/manage/manage.js";
export { SyncStopped } from "./internal/sync/sync.js";

export { Changed as InstalledSkillsChanged } from "./installed-skill-facts.js";

export { SkillsShUpdateMember, SkillsShUpdateReason } from "./check-facts.js";
export { LibraryRecoveryNotice } from "./recovery-notice.js";
