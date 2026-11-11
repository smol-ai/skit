import { StepDefect, StepSchemaFailure, LegacyStepFailureFromText } from "../recorded-failures.js";
import { SyncInputInvalid } from "../sync-input-failures.js";
import { LibraryAuditInvalid } from "../audit/failures.js";
import { RestoreInvalid } from "../restore-failures.js";
import { UpdateFailure } from "../update-failures.js";
import { ImportFailure } from "../import-failures.js";
import { PluginFailure } from "../../sources/plugin-failures.js";
import { DedicatedInstallerRequired } from "../../sources/installer-guidance.js";
import { PnpmSkillManaged } from "../../installed-skills/pnpm-failures.js";
import { UnknownHarness } from "../../harnesses/probe-failures.js";
import { SourceRestoreInvalid } from "../source-restore-failures.js";
import { SourceFetchFailure } from "../../sources/fetch-failures.js";
import { EditImportFailure } from "../edit-failures.js";
import { SyncLocalChanged, SyncConflicted } from "../internal/sync/conflict.js";
import { InvalidUsageOptions } from "../usage/contracts.js";
import { SetupReviewFailure } from "../setup-failures.js";
import { MachineSettingsFailure } from "../machine-settings-failures.js";
import { AuthorHistoryFailure } from "../../author/history-failures.js";
import { StoreError } from "../../history/history.js";
import { SyncFailure } from "../../sync/failures.js";
import { SkitContractError } from "../../api/contracts.js";
import { WorkspaceFailure } from "../../author/workspace-contracts.js";
import { AuthorFailure } from "../../author/failures.js";
import { CollectionVersionArchiveInvalid } from "../snapshot-archive-universal.js";
import { SetEnabledIncomplete } from "../internal/session/set-enabled-contract.js";
import { DuplicateScanIncomplete, Changed } from "../installed-skill-facts.js";
import { InvocationUnavailable } from "../invocation-failure.js";
import { SourceFailure } from "../../sources/failures.js";
import {
  DescriptorFailure,
  SkillDiscoveryLimitExceeded,
  SkillNameInvalid,
  SkitValidationFailed,
} from "../../artifact/failures.js";
import { HarnessMetadataInvalid } from "../../harnesses/metadata-failures.js";
import {
  StalePlan,
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
} from "../plan-failures.js";
import { InstalledSkillInvalid } from "../installation/install-enabled.js";
import {
  UninstallConflict,
  UnsafeInstalledSkillName,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  InstalledSkillFileMissing,
} from "../../installed-skills/failures.js";
import { InstalledSkillFailure } from "../../installed-skills/files.js";
import { Schema } from "effect";
import { PlatformErrorSchema } from "../../platform/error-schema.js";
import {
  ImportContentInvalid,
  AddNoSkills,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  SetupImportInvalid,
  AcceptanceIncomplete,
  ContentAddressCollision,
  SecurityFindingAbsent,
  UnknownInstalledSkill,
  InvalidLibraryState,
  LibraryChanged,
  ManageSelectionInvalid,
  SetupStepsInvalid,
} from "../failures.js";
import {
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
} from "../installation/remove.js";
import { StoredHomeBusy } from "./step-error-compat.js";
import { TreeError } from "../../shared/tree-error.js";
import { InvalidIntent, SetEnabledInvalid } from "../enabled-plan.js";
import { Hash } from "../../shared/hash.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";
import { RecoveryReason } from "../recovery-facts.js";

// ── Operation records ───────────────────────────────────────────────────────────────────────────
// Setup records each operation durably before applying its folder changes (ADR-0020).
// Each codec decodes to the contract's shape; `state.json` holds its JSON encoding, so the state
// document stays a plain JSON value: Options are optional keys and device and inode numbers text.

/** A file's identity: exact device and inode, saved as decimal text. */
export const FileIdentity = Schema.Struct({
  path: Schema.String,
  dev: Schema.BigIntFromString,
  ino: Schema.BigIntFromString,
});

export type FileIdentity = typeof FileIdentity.Type;

const FileIdentityFields = FileIdentity.fields;

export const FolderEvidence = Schema.TaggedStruct("Directory", {
  ...FileIdentityFields,
  parent: FileIdentity,
  contentHash: Hash,
  treeHash: Hash,
  marker: Schema.OptionFromOptionalKey(Schema.String),
});

export type FolderEvidence = typeof FolderEvidence.Type;

export const LinkEvidence = Schema.TaggedStruct("SymbolicLink", {
  ...FileIdentityFields,
  parent: FileIdentity,
  linkTarget: Schema.String,
  canonicalPath: Schema.String,
  contentHash: Hash,
});

export type LinkEvidence = typeof LinkEvidence.Type;

/** Typed owner failures and native schema/platform errors retain their facts. Unexpected
 * defects have an explicit branch; old stored sentences decode as historical evidence. */
export const StepError = Schema.Union([
  LegacyStepFailureFromText,
  LibraryAuditInvalid,
  RestoreInvalid,
  UpdateFailure,
  ImportFailure,
  PluginFailure,
  DedicatedInstallerRequired,
  PnpmSkillManaged,
  UnknownHarness,
  SourceRestoreInvalid,
  SourceFetchFailure,
  EditImportFailure,
  SyncLocalChanged,
  SyncInputInvalid,
  InvalidUsageOptions,
  SetupReviewFailure,
  MachineSettingsFailure,
  AuthorHistoryFailure,
  StoreError,
  SyncFailure,
  SkitContractError,
  AuthorFailure,
  WorkspaceFailure,
  CollectionVersionArchiveInvalid,
  SetEnabledIncomplete,
  DuplicateScanIncomplete,
  InvocationUnavailable,
  SourceFailure,
  DescriptorFailure,
  SkillDiscoveryLimitExceeded,
  SkillNameInvalid,
  SkitValidationFailed,
  HarnessMetadataInvalid,
  ImportContentInvalid,
  AddNoSkills,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  SetupImportInvalid,
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
  Changed,
  StalePlan,
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  TreeError,
  UninstallConflict,
  UnsafeInstalledSkillName,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  InstalledSkillFileMissing,
  InstalledSkillFailure,
  InstalledSkillInvalid,
  // A recovery failure can itself carry a recorded stop reason; defer that recursive edge.
  Schema.suspend(() => RecoveryInvalid),
  StoredHomeBusy,
  AcceptanceIncomplete,
  ContentAddressCollision,
  SecurityFindingAbsent,
  UnknownInstalledSkill,
  LibraryChanged,
  InvalidLibraryState,
  InvalidIntent,
  ManageSelectionInvalid,
  SetEnabledInvalid,
  SetupStepsInvalid,
  SyncConflicted,
  PlatformErrorSchema,
  StepDefect,
  StepSchemaFailure,
]).annotate({ identifier: "StepError" });

export type StepError = typeof StepError.Type;

/** Why an operation stopped. */
export const SetupStopReason = Schema.TaggedUnion({
  EvidenceDiffers: {
    step: Schema.Int,
    path: Schema.String,
    expected: Schema.Struct({
      before: Schema.OptionFromOptionalKey(Schema.Union([FolderEvidence, LinkEvidence])),
      after: Schema.OptionFromOptionalKey(Schema.Union([FolderEvidence, LinkEvidence])),
    }),
  },
  /** `revision` is a Library `Revision`. */
  LibraryChanged: {
    step: Schema.Int,
    revision: Schema.NonEmptyString.pipe(Schema.brand("Revision")),
  },
  StepFailed: { step: Schema.Int, error: StepError },
}).annotate({ identifier: "SetupStopReason" });

export type SetupStopReason = typeof SetupStopReason.Type;

/** A stopped operation can itself contain a recovery failure, so its schema is suspended. */
export type RecoveryInvalidReason =
  | typeof RecoveryReason.Type
  | {
      readonly _tag: "OperationStopped";
      readonly operation: "Undo" | "Restore";
      readonly operationId: string;
      readonly reason: SetupStopReason;
    };

export const OperationStopped = Schema.TaggedStruct("OperationStopped", {
  operation: Schema.Literals(["Undo", "Restore"]),
  operationId: Schema.String,
  reason: Schema.suspend((): Schema.Codec<SetupStopReason, unknown> => SetupStopReason),
});

export const RecoveryInvalidReason: Schema.Codec<RecoveryInvalidReason, unknown> = Schema.Union([
  RecoveryReason,
  OperationStopped,
]).annotate({ identifier: "RecoveryInvalidReason" });

export class RecoveryInvalid
  extends Schema.TaggedError<RecoveryInvalid, { readonly brand: unique symbol }>()(
    "RecoveryInvalid",
    { reason: RecoveryInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  // The recursive codec's constructor input is unknown; callers still supply a typed reason.
  constructor(fields: { readonly reason: RecoveryInvalidReason }, options?: Schema.MakeOptions) {
    super(fields, options);
  }
}
