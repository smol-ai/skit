import { DiscoveryEvidence, MachineRepositoryDecision } from "../machine-document.js";
import { SetupIntentChanges } from "./setup-intent.js";
import { SetupIntent } from "./setup-intent.js";
import {
  FileIdentity,
  FolderEvidence,
  LinkEvidence,
  SetupStopReason,
} from "./operation-failures.js";
export {
  FileIdentity,
  FolderEvidence,
  LinkEvidence,
  StepError,
  SetupStopReason,
} from "./operation-failures.js";
import { InstalledSkillInvalidReason } from "../installation/install-enabled.js";

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
import { InstalledSkill, InstalledSkillInstalled, Invocation } from "../device-state.js";
import { UndoFile, UndoPath, UndoAction } from "../internal/setup/undo-evidence.js";
import { RecoveryInspection } from "../recovery-facts.js";
import { EnabledChange } from "../enabled-change.js";
import { SyncIssue } from "../sync-issues.js";
import { Destination } from "../installed-skill-facts.js";
import { Hash } from "../../shared/hash.js";
import { HarnessName } from "../../harnesses/contracts.js";
import { InstallDestination } from "../../installed-skills/destination.js";
import { InstallScope } from "../scope.js";

export { InventoryScanIssue, SyncAncestry, CURRENT_LIBRARY_STATE_VERSION } from "./state-fields.js";

import { LibraryDifference } from "./difference.js";
/** Where states before v11 recorded a copy, including former per-Harness folders. */
export const RecordedInstallDestination = Schema.Literals(["agents", "claude", "legacy"]);
export type RecordedInstallDestination = typeof RecordedInstallDestination.Type;
/** Recorded "nothing here": the before of a created folder, the after of a moved one. */
export const AbsentEvidence = Schema.TaggedStruct("Absent", {
  path: Schema.String,
  parent: FileIdentity,
});
export type AbsentEvidence = typeof AbsentEvidence.Type;

/**
 * A retained Collection Version in originals/, Import's only folder effect, and the Collection
 * the import saved it to. Collections with identical bytes share a Version, so the hash alone does
 * not say which Collection an import made.
 */
const RetainedEvidence = Schema.TaggedStruct("Retained", {
  hash: Hash,
  collectionId: CollectionId,
});

const PathEvidence = Schema.Union([FolderEvidence, LinkEvidence, AbsentEvidence]);
export const StepEvidence = Schema.Union([PathEvidence, RetainedEvidence]);
export type StepEvidence = typeof StepEvidence.Type;

/** An import of observed skills, exactly as `importCollection` takes it. */
const ImportRequest = Schema.Struct({
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

const DuplicatePolicy = Schema.Literals([
  "keep-both",
  "preserve-duplicates",
  "retire-aliases",
  "retain-only",
]);

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

const VersionChoice = Schema.Struct({
  skillId: SkillId,
  version: Schema.Literals(["retained", "local"]),
  path: Schema.OptionFromOptionalKey(Schema.String),
});

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

/** Lossless installer observations, kept without requiring installer construction when decoding. */
export const SyncFolder = Schema.Struct({
  path: Schema.String,
  entry: Schema.Literals(["Absent", "Directory", "SymbolicLink", "File", "Other"]),
  evidence: Schema.String,
  ancestors: Schema.Array(Schema.Struct({ path: Schema.String, evidence: Schema.String })),
});
export type SyncFolder = typeof SyncFolder.Type;
const syncProgram = Schema.Struct({
  save: Schema.optionalKey(Schema.Literal("before")),
  difference: LibraryDifference,
  routing: StepRouting,
  retire: Schema.Array(InstalledSkill),
  drop: Schema.Array(InstalledSkillId),
  manifestDigest: Hash,
  receiptAccepted: Schema.Boolean,
  folders: Schema.Array(SyncFolder),
  issues: Schema.Array(Schema.suspend((): Schema.Codec<SyncIssue, unknown> => SyncIssue)),
});
export interface SyncProgram extends Schema.Schema.Type<typeof syncProgram> {}
export interface StoredSyncProgram extends Schema.Codec.Encoded<typeof syncProgram> {}
export const SyncProgram: Schema.Codec<SyncProgram, StoredSyncProgram> = syncProgram;

const RecordedInstalledSkill = Schema.declare(Schema.is(InstalledSkill), {
  identifier: "RecordedInstalledSkill",
  toCodecJson: () => undefined,
});

/** Exact installed changes, compiled once from a revalidated review. */
export const RecordedInstalledChange = Schema.Union([
  Schema.TaggedStruct("Install", {
    row: Schema.declare(Schema.is(InstalledSkillInstalled), {
      identifier: "RecordedInstalledSkillInstalled",
      toCodecJson: () => undefined,
    }),
    invocation: Invocation,
    verification: Schema.Literals(["write", "replacement", "manage", "marker"]),
  }),
  Schema.TaggedStruct("Save", {
    row: RecordedInstalledSkill,
    result: Schema.Literals(["Unchanged", "Suppressed", "Conflicted"]),
    /** A reviewed edit is copied to variants before its conflict row is saved. */
    backUp: Schema.Boolean,
  }),
  Schema.TaggedStruct("Uninstall", { id: InstalledSkillId, keep: Schema.Boolean }),
  Schema.TaggedStruct("Forget", { id: InstalledSkillId, keep: Schema.Boolean }),
  Schema.TaggedStruct("Fail", { path: Schema.String, reason: InstalledSkillInvalidReason }),
]).check(
  Schema.makeFilter(
    (change) =>
      change._tag !== "Save" ||
      (change.result === "Unchanged"
        ? change.row.status === "installed" && !change.backUp
        : change.result === "Suppressed"
          ? change.row.status === "suppressed" && !change.backUp
          : change.row.status === "conflicted"),
    { representation: { id: "skit/schema/installed-change-status", payload: null } },
  ),
);
export type RecordedInstalledChange = typeof RecordedInstalledChange.Type;
const installedApply = Schema.TaggedStruct("Apply", {
  beforeHash: Hash,
  afterHash: Hash,
  previousInstalledSkills: Schema.Array(
    Schema.declare(Schema.is(InstalledSkill), {
      identifier: "PreviousInstalledSkill",
      toCodecJson: () => undefined,
    }),
  ),
  bodyChange: Schema.optionalKey(
    Schema.Union([
      Schema.TaggedStruct("Enabled", {
        fields: Schema.Array(
          Schema.Struct({
            field: Schema.String,
            before: Schema.optionalKey(Schema.Json),
            after: Schema.optionalKey(Schema.Json),
          }),
        ),
      }),
      Schema.TaggedStruct("Remove", { collectionId: CollectionId }),
    ]),
  ),
  routing: StepRouting,
  /** Removal keeps the old Collection until its installed folders have been handled. */
  save: Schema.Literals(["before", "after"]),
  enabled: Schema.Array(
    Schema.Struct({
      change: EnabledChange,
      skillIds: Schema.Array(SkillId),
      targets: Schema.Array(Destination),
    }),
  ),
  folders: Schema.Array(SyncFolder),
  changes: Schema.Array(RecordedInstalledChange),
  phase: Schema.Union([
    Schema.TaggedStruct("Pending", {}),
    Schema.TaggedStruct("Done", { folders: Schema.Array(SyncFolder) }),
  ]),
});

export namespace InstalledApply {
  export interface Type extends Schema.Schema.Type<typeof installedApply> {}
}
export type InstalledApply = InstalledApply.Type;
export interface StoredInstalledApply extends Schema.Codec.Encoded<typeof installedApply> {}
export const InstalledApply: Schema.Codec<InstalledApply, StoredInstalledApply> = installedApply;

export const RecoveryRestore = Schema.Struct({
  summary: Schema.suspend(() => RecoveryInspection),
  witnesses: Schema.Array(Schema.String),
  parents: Schema.Array(Schema.String),
  structure: Schema.String,
  content: Schema.Array(
    Schema.Struct({
      original: Schema.optionalKey(Schema.String),
      saved: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type RecoveryRestore = typeof RecoveryRestore.Type;

/** Reviewed inverse data. Publications never embed operation history. */
export const UndoProgram = Schema.Struct({
  operationId: Schema.String,
  backupId: Schema.String.check(Schema.isUUID(4)),
  difference: LibraryDifference,
  discovery: Schema.optionalKey(
    Schema.Struct({
      beforeHash: Hash,
      afterHash: Hash,
      before: DiscoveryEvidence,
      after: DiscoveryEvidence,
    }),
  ),
  files: Schema.Array(UndoFile),
  paths: Schema.Array(UndoPath),
  sources: Schema.Array(UndoPath),
  sourceImports: Schema.Array(Schema.Struct({ path: Schema.String, hash: Hash })),
  actions: Schema.Array(UndoAction),
  preserve: Schema.Array(Schema.Union([FolderEvidence, LinkEvidence])),
  preserved: Schema.Boolean,
});
export type UndoProgram = typeof UndoProgram.Type;

export const SetupStep = Schema.Union([
  Schema.TaggedStruct("Undo", { program: UndoProgram }),
  Schema.TaggedStruct("Restore", { program: RecoveryRestore }),
  InstalledApply,
  Schema.TaggedStruct("Sync", { phase: Schema.Literal("retire"), program: SyncProgram }),
  Schema.TaggedStruct("Sync", {
    phase: Schema.Literals(["publish", "install"]),
    sourceStep: Schema.Int,
  }),
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
  /** Older Update records lost the approved selection and must not resume. */
  updateSelection: Schema.optionalKey(Schema.Literal("reviewed")),
  /** Named installed-change batches, when this step changes installed files. */
  applies: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, apply: InstalledApply })),
  ),
  before: Schema.Array(StepEvidence),
  after: Schema.Array(StepEvidence),
  status: Schema.Literals(["Pending", "Done"]),
});
export type RecordedSetupStep = typeof RecordedSetupStep.Type;

/** The desired fields a setup can change. Retained versions and history are not among them. */
export { SetupIntent } from "./setup-intent.js";

/**
 * The parts of the Library a setup can change, as one write of its record saw them: before any
 * step ran, and once it finished or stopped. Undo reverses only what changed between the two.
 */
export const RecordedLibrary = Schema.Struct({
  intent: Schema.optionalKey(SetupIntent),
  installedSkills: Schema.Array(RecordedInstalledSkill),
});
export type RecordedLibrary = typeof RecordedLibrary.Type;

/** Status of one recorded operation (setup, restore, undo). */
/**
 * Every status keeps its steps and their evidence: undo needs a Done or Stopped operation's
 * evidence as much as resuming needs a Pending one's.
 */
export const OperationKind = Schema.Literals(["setup", "apply", "sync", "undo", "restore"]);
export type OperationKind = typeof OperationKind.Type;

export const SetupPreparation = Schema.Struct({
  roots: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      ancestors: Schema.Array(Schema.Struct({ path: Schema.String, evidence: Schema.String })),
    }),
  ),
  done: Schema.Boolean,
});
export type SetupPreparation = typeof SetupPreparation.Type;

export const SetupRecord = Schema.Struct({
  changes: SetupIntentChanges,
  discovery: Schema.optionalKey(
    Schema.Struct({ before: DiscoveryEvidence, expectedAfter: DiscoveryEvidence }),
  ),
  machineChoices: Schema.optionalKey(
    Schema.Struct({
      discoveryRoots: Schema.optionalKey(Schema.Array(Schema.String)),
      repositories: Schema.optionalKey(Schema.Array(MachineRepositoryDecision)),
      displayName: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type SetupRecord = typeof SetupRecord.Type;

/** Terminal/history evidence cannot execute filesystem work. */
export const OperationStepSummary = Schema.Struct({
  step: Schema.Union([
    Schema.TaggedStruct("Undo", {
      program: Schema.Struct({
        operationId: Schema.String,
        backupId: Schema.String.check(Schema.isUUID(4)),
      }),
    }),
    Schema.Struct({
      _tag: Schema.Literals(["Apply", "Sync", "Import", "Manage", "Update", "Remove", "Restore"]),
    }),
  ]),
  before: Schema.Array(PathEvidence),
  after: Schema.Array(PathEvidence),
  status: Schema.Literals(["Pending", "Done"]),
});
export type OperationStepSummary = typeof OperationStepSummary.Type;
const operationSummaryFields = {
  setup: Schema.optionalKey(SetupRecord),
  operationId: OperationId,
  kind: Schema.optionalKey(OperationKind),
  steps: Schema.Array(OperationStepSummary),
  before: RecordedLibrary,
};
export const OperationSummary = Schema.TaggedUnion({
  Pending: operationSummaryFields,
  Done: { ...operationSummaryFields, after: RecordedLibrary },
  Stopped: { ...operationSummaryFields, after: RecordedLibrary, reason: SetupStopReason },
  Undone: {
    ...operationSummaryFields,
    after: RecordedLibrary,
    reason: Schema.optionalKey(SetupStopReason),
  },
});
export type OperationSummary = typeof OperationSummary.Type;

export const OperationStatus = Schema.TaggedUnion({
  Pending: {
    setup: Schema.optionalKey(SetupRecord),
    kind: Schema.optionalKey(OperationKind),
    preparation: Schema.optionalKey(SetupPreparation),
    operationId: OperationId,
    steps: Schema.Array(RecordedSetupStep),
    before: RecordedLibrary,
  },
  Done: {
    setup: Schema.optionalKey(SetupRecord),
    operationId: OperationId,
    kind: Schema.optionalKey(OperationKind),
    steps: Schema.Array(Schema.Union([RecordedSetupStep, OperationStepSummary])),
    before: RecordedLibrary,
    after: RecordedLibrary,
  },
  Stopped: {
    setup: Schema.optionalKey(SetupRecord),
    operationId: OperationId,
    kind: Schema.optionalKey(OperationKind),
    steps: Schema.Array(Schema.Union([RecordedSetupStep, OperationStepSummary])),
    reason: SetupStopReason,
    before: RecordedLibrary,
    after: RecordedLibrary,
  },
  Undone: {
    setup: Schema.optionalKey(SetupRecord),
    operationId: OperationId,
    kind: Schema.optionalKey(OperationKind),
    steps: Schema.Array(Schema.Union([RecordedSetupStep, OperationStepSummary])),
    before: RecordedLibrary,
    after: RecordedLibrary,
    reason: Schema.optionalKey(SetupStopReason),
  },
});
export type OperationStatus = typeof OperationStatus.Type;
