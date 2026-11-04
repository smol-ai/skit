import { Schema } from "effect";
import {
  CollectionId,
  InstalledSkillId,
  MachineId,
  OperationId,
  SkillId,
  SkillVersionId,
} from "../entity-ids.js";
import { SkillsShLockFileEntry, SkitSource } from "../library-contracts.js";
import { FileIdentityNumber } from "../../platform/link-stat.js";
import { Hash, HarnessName, InstallDestination, InstallScope } from "../../vocabulary.js";

// Decoded state is readonly except where the transaction API revises a candidate in place.
// Each Schema.mutableKey below marks one such field; every other field stays readonly, so
// the schema records exactly which parts of a snapshot the reconciler is allowed to touch.
// Schema.optional retains existing candidate undefined values; JSON omits those keys.
export const InventoryScanIssue = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("MISSING_ROOT"),
  }),
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("UNREADABLE_PATH"),
  }),
  Schema.Struct({
    path: Schema.String,
    target: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("DANGLING_SYMLINK"),
  }),
]);
export type InventoryScanIssue = typeof InventoryScanIssue.Type;
export const SkillAssessmentAcceptance = Schema.Struct({
  fingerprint: Hash,
  artifactContentHash: Hash,
  skill_version_id: SkillVersionId,
  context: Schema.Literal("project"),
  principal: Schema.String,
  rationale: Schema.String,
  acceptedAt: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
});
export type SkillAssessmentAcceptance = typeof SkillAssessmentAcceptance.Type;
export const HarnessInstallStatus = Schema.Literals([
  "pending",
  "installed",
  "drifted",
  "conflicted",
  "unsupported",
  "suppressed",
]);
export type HarnessInstallStatus = typeof HarnessInstallStatus.Type;
/** Where states before v11 recorded a copy, including former per-Harness folders. */
export const RecordedInstallDestination = Schema.Literals(["agents", "claude", "legacy"]);
export type RecordedInstallDestination = typeof RecordedInstallDestination.Type;
export const OwnershipIssue = Schema.Struct({
  code: Schema.Literals(["ORPHANED_OWNERSHIP_MARKER", "INVALID_OWNERSHIP_MARKER"]),
  path: Schema.String,
  canonicalPath: Schema.String,
  harnesses: Schema.mutable(Schema.Array(HarnessName)),
  currentHash: Hash,
  detail: Schema.optional(Schema.String),
  collectionId: Schema.optional(CollectionId),
  skillId: Schema.optional(SkillId),
  installedSkillId: Schema.optional(InstalledSkillId),
  expectedHash: Schema.optional(Hash),
  matchesExpectedHash: Schema.optional(Schema.Boolean),
});
export type OwnershipIssue = typeof OwnershipIssue.Type;
export const LibraryDeviceStateFields = {
  unmanaged: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          harness: HarnessName,
          /** All Harnesses that observed this one physical path during the latest pass. */
          harnesses: Schema.optional(Schema.mutable(Schema.Array(HarnessName))),
          path: Schema.String,
          paths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
          currentHash: Hash,
          lastHash: Schema.optional(Hash),
        }),
      ),
    ),
  ),
  ownershipIssues: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(OwnershipIssue)))),
  scanIssues: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(InventoryScanIssue)))),
  assessmentAcceptances: Schema.mutableKey(
    Schema.optional(Schema.mutable(Schema.Array(SkillAssessmentAcceptance))),
  ),
} as const;

// ── Operation records ───────────────────────────────────────────────────────────────────────────
// Setup's record of each operation (architecture/library.ts OperationStatus, RecordedSetupStep).
// Each codec decodes to the contract's shape; `state.json` holds its JSON encoding, so the state
// document stays a plain JSON value: Options are optional keys and device and inode numbers text.

/** A file's identity: exact device and inode, saved as decimal text. */
export const FileIdentity = Schema.Struct({
  path: Schema.String,
  dev: FileIdentityNumber,
  ino: FileIdentityNumber,
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

/** Recorded "nothing here": the before of a created folder, the after of a moved one. */
export const AbsentEvidence = Schema.TaggedStruct("Absent", {
  path: Schema.String,
  parent: FileIdentity,
});
export type AbsentEvidence = typeof AbsentEvidence.Type;

/** A retained Collection Version in originals/: Import's only folder effect, additive. */
export const RetainedEvidence = Schema.TaggedStruct("Retained", { hash: Hash });
export type RetainedEvidence = typeof RetainedEvidence.Type;

export const PathEvidence = Schema.Union([FolderEvidence, LinkEvidence, AbsentEvidence]);
export type PathEvidence = typeof PathEvidence.Type;
export const StepEvidence = Schema.Union([PathEvidence, RetainedEvidence]);
export type StepEvidence = typeof StepEvidence.Type;

/** An import of observed skills, exactly as `importCollection` takes it. */
export const ImportRequest = Schema.Struct({
  machineId: Schema.optionalKey(MachineId),
  input: Schema.String,
  source: SkitSource,
  declaration: Schema.optionalKey(
    Schema.Struct({
      namespace: Schema.String,
      slug: Schema.String,
      authority: Schema.optionalKey(Schema.String),
    }),
  ),
  revision: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("commit"), commit: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("release"), version: Schema.String }),
    ]),
  ),
  importedAt: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      sourcePath: Schema.String,
      relativePath: Schema.String,
      currentHash: Hash,
    }),
  ),
  lockFileEntries: Schema.Array(SkillsShLockFileEntry),
});
export type ImportRequest = typeof ImportRequest.Type;

export const DuplicatePolicy = Schema.Literals([
  "keep-both",
  "preserve-duplicates",
  "retire-aliases",
  "retain-only",
]);
export type DuplicatePolicy = typeof DuplicatePolicy.Type;

const ManageSelectionFields = {
  name: Schema.String,
  source: FolderEvidence,
  duplicates: Schema.OptionFromOptionalKey(DuplicatePolicy),
  approvedSymlinks: Schema.Array(LinkEvidence),
  approvedCopies: Schema.Array(FolderEvidence),
} as const;

export const ManageExistingSelection = Schema.Struct({
  ...ManageSelectionFields,
  mode: Schema.Literal("existing"),
  subjectId: Schema.String,
  currentHash: Hash,
});
export type ManageExistingSelection = typeof ManageExistingSelection.Type;

/** Where a setup "new" copy's files come from: its own import, a Collection, or an earlier step. */
export const ManageStepSource = Schema.TaggedUnion({
  Import: { request: ImportRequest },
  Collection: { collectionId: CollectionId },
  Step: { step: Schema.Int },
});
export type ManageStepSource = typeof ManageStepSource.Type;

/** A "new" selection as setup records it, its source being a `ManageStepSource`. */
export const ManageNewSelection = Schema.Struct({
  ...ManageSelectionFields,
  mode: Schema.Literal("new"),
  importFrom: ManageStepSource,
  currentHash: Schema.OptionFromOptionalKey(Hash),
  equalCopies: Schema.Array(FolderEvidence),
  ownership: Schema.OptionFromOptionalKey(
    Schema.Struct({
      harnesses: Schema.Array(HarnessName),
      machineId: Schema.OptionFromOptionalKey(MachineId),
    }),
  ),
});
export type ManageNewSelection = typeof ManageNewSelection.Type;

/** A reviewed copy change, frozen at review. */
export const ReviewedInstalledSkillChange = Schema.Struct({
  installedSkillId: Schema.OptionFromOptionalKey(InstalledSkillId),
  skillId: SkillId,
  name: Schema.String,
  path: Schema.String,
  destination: InstallDestination,
  baselineHash: Schema.OptionFromOptionalKey(Hash),
  currentHash: Schema.OptionFromOptionalKey(Hash),
  desiredHash: Schema.OptionFromOptionalKey(Hash),
  desiredVersionId: Schema.OptionFromOptionalKey(SkillVersionId),
  evidence: Hash,
  status: Schema.Literals([
    "unchanged",
    "incoming-update",
    "local-only",
    "competing",
    "protected",
    "native-delete",
    "uninstall",
    "install",
  ]),
  metadataChanged: Schema.Boolean,
});
export type ReviewedInstalledSkillChange = typeof ReviewedInstalledSkillChange.Type;

export const VersionChoice = Schema.Struct({
  skillId: SkillId,
  version: Schema.Literals(["retained", "local"]),
  path: Schema.OptionFromOptionalKey(Schema.String),
});
export type VersionChoice = typeof VersionChoice.Type;

/**
 * Where a step installs and which folders agents read, resolved from this machine's configuration
 * once, when the steps are built. A re-run routes by this record, never by the configuration.
 */
export const StepRouting = Schema.Struct({
  active: Schema.Array(InstallDestination),
  destinations: Schema.Array(
    Schema.Struct({ scope: InstallScope, destination: InstallDestination, root: Schema.String }),
  ),
  readable: Schema.Array(
    Schema.Struct({ scope: InstallScope, harness: HarnessName, root: Schema.String }),
  ),
});
export type StepRouting = typeof StepRouting.Type;

export const SetupStep = Schema.Union([
  Schema.TaggedStruct("Import", { request: ImportRequest }),
  Schema.TaggedStruct("Manage", {
    mode: Schema.Literal("existing"),
    selections: Schema.Array(ManageExistingSelection),
    routing: StepRouting,
  }),
  Schema.TaggedStruct("Manage", {
    mode: Schema.Literal("new"),
    selections: Schema.Array(ManageNewSelection),
    routing: StepRouting,
  }),
  Schema.TaggedStruct("Update", {
    changes: Schema.Array(ReviewedInstalledSkillChange),
    versionChoices: Schema.Array(VersionChoice),
    /** When each local choice is imported: a re-run finds the edit it imported and skips it. */
    importedAt: Schema.String,
    routing: StepRouting,
  }),
  Schema.TaggedStruct("Remove", {
    folders: Schema.Array(Schema.Union([FolderEvidence, LinkEvidence])),
  }),
]);
export type SetupStep = typeof SetupStep.Type;

/** One step as saved before any step runs; Done once its effect is complete. */
export const RecordedSetupStep = Schema.Struct({
  step: SetupStep,
  before: Schema.Array(StepEvidence),
  after: Schema.Array(StepEvidence),
  status: Schema.Literals(["Pending", "Done"]),
});
export type RecordedSetupStep = typeof RecordedSetupStep.Type;

/** Why an operation stopped. A failed step's error is kept as JSON, as Effect saves defects. */
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
  StepFailed: { step: Schema.Int, error: Schema.Defect() },
});
export type SetupStopReason = typeof SetupStopReason.Type;

/** Status of one recorded operation (setup, restore, undo). */
export const OperationStatus = Schema.TaggedUnion({
  Pending: { operationId: OperationId, steps: Schema.Array(RecordedSetupStep) },
  Done: { operationId: OperationId },
  Stopped: { operationId: OperationId, reason: SetupStopReason },
});
export type OperationStatus = typeof OperationStatus.Type;
