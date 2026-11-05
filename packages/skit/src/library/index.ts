/** Public Library owner operations and read models. Storage and writers stay private. */
export * as Library from "./library.js";
export type { Service } from "./library.js";
export { ImportContentInvalid } from "./failures.js";
export { InstallScope } from "./scope.js";
export { InstallDestination } from "../installed-skills/destination.js";
export { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
export { LibraryAuditEvent } from "./audit/audit-log.js";
export { RecoveryInspection } from "./recovery-facts.js";
export { RestoreInvalid } from "./library.js";
export type { RestoreProgress, RestorePhase } from "./restore-progress.js";
// Canonical result and failure names keep consumer declarations on the owner API.
export type {
  LibraryLayerError,
  LibraryStateReadError,
  ApplyError,
  ManageStopped,
  SyncStopped,
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
} from "./library.js";
export type {
  ImportRequestInvalid,
  ImportedCollection,
  InstalledSkillChanged,
  ImportedEdit,
} from "./import-collection.js";
export type { SkillMaterializationInvalid } from "./installed-skill-hash.js";
export type { LibraryAuditInvalid } from "./audit/audit-log.js";
export type { InvalidIntent } from "./enabled-plan.js";
export type { InstalledSkillInvalid } from "./installation/install-enabled.js";
export type {
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
} from "./installation/remove.js";
export type { RecoveryInvalid } from "./recovery-facts.js";
