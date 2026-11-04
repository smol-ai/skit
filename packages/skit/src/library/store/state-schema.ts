import { Schema, SchemaGetter } from "effect";
import {
  badArgument,
  isPlatformError,
  systemError,
  type PlatformError,
} from "effect/PlatformError";
import { InvalidLibraryState, LibraryBusy, LibraryChanged } from "../../failures.js";
import { TreeError } from "../../shared/tree-error.js";
import {
  CollectionId,
  CollectionVersionId,
  ImportId,
  InstalledSkillId,
  MachineId,
  OperationId,
  SkillId,
  SkillVersionId,
} from "../entity-ids.js";
import { Enabled, SkillsShLockFileEntry, SkitSource } from "../library-contracts.js";
import {
  DeviceSkillSelection,
  InstalledSkill,
  InvocationPolicies,
  Repository,
} from "../device-state.js";
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

/**
 * A retained Collection Version in originals/, Import's only folder effect, and the Collection
 * the import saved it to. Collections with identical bytes share a Version, so the hash alone does
 * not say which Collection an import made.
 */
export const RetainedEvidence = Schema.TaggedStruct("Retained", {
  hash: Hash,
  collectionId: CollectionId,
});
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

const SystemErrorTags = Schema.Literals([
  "AlreadyExists",
  "BadResource",
  "Busy",
  "InvalidData",
  "NotFound",
  "PermissionDenied",
  "TimedOut",
  "UnexpectedEof",
  "Unknown",
  "WouldBlock",
  "WriteZero",
]);

/**
 * Effect's PlatformError, stored as the fields it exposes. Its `cause` can be any value, so it is
 * not stored; a read-back error has none.
 */
export const StoredPlatformError = Schema.Struct({
  _tag: Schema.Literal("PlatformError"),
  reason: Schema.Struct({
    _tag: Schema.Union([SystemErrorTags, Schema.Literal("BadArgument")]),
    module: Schema.String,
    method: Schema.String,
    description: Schema.optionalKey(Schema.String),
    syscall: Schema.optionalKey(Schema.String),
    pathOrDescriptor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  }),
}).pipe(
  Schema.decodeTo(Schema.declare(isPlatformError), {
    decode: SchemaGetter.transform(({ reason }) => {
      const { _tag, module, method, description, syscall, pathOrDescriptor } = reason;
      return _tag === "BadArgument"
        ? badArgument({ module, method, ...(description === undefined ? {} : { description }) })
        : systemError({
            _tag,
            module,
            method,
            ...(description === undefined ? {} : { description }),
            ...(syscall === undefined ? {} : { syscall }),
            ...(pathOrDescriptor === undefined ? {} : { pathOrDescriptor }),
          });
    }),
    encode: SchemaGetter.transform(({ reason }: PlatformError) => ({
      _tag: "PlatformError" as const,
      reason: {
        _tag: reason._tag,
        module: reason.module,
        method: reason.method,
        ...(reason.description === undefined ? {} : { description: reason.description }),
        ...(reason._tag === "BadArgument" || reason.syscall === undefined
          ? {}
          : { syscall: reason.syscall }),
        ...(reason._tag === "BadArgument" || reason.pathOrDescriptor === undefined
          ? {}
          : { pathOrDescriptor: reason.pathOrDescriptor }),
      },
    })),
  }),
);

/** Any other SKIT failure, stored as what every SKIT failure says about itself. */
export const StoredFailure = Schema.Struct({
  _tag: Schema.String,
  code: Schema.String,
  message: Schema.String,
  remediation: Schema.String,
});
export type StoredFailure = typeof StoredFailure.Type;

/**
 * A failed step's error. These errors are stored in full; any other is stored as a
 * `StoredFailure`, so a stopped operation can always be recorded.
 */
export const StepError = Schema.Union([
  TreeError,
  LibraryBusy,
  LibraryChanged,
  InvalidLibraryState,
  StoredPlatformError,
  StoredFailure,
]);
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
});
export type SetupStopReason = typeof SetupStopReason.Type;

/** The desired fields a setup can change. Retained versions and history are not among them. */
export const SetupIntent = Schema.Struct({
  /** The account's global list. */
  global: Schema.Struct({
    enabled: Schema.Array(Enabled),
    invocation_policies: Schema.optionalKey(InvocationPolicies),
  }),
  repositories: Schema.Array(Repository),
  device: Schema.NullOr(DeviceSkillSelection),
  sources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        collectionId: CollectionId,
        importId: ImportId,
        collectionVersionId: CollectionVersionId,
      }),
    ),
  ),
  memberships: Schema.optionalKey(
    Schema.Array(Schema.Struct({ collectionId: CollectionId, skillIds: Schema.Array(SkillId) })),
  ),
  versions: Schema.Array(
    Schema.Struct({
      skillId: SkillId,
      selected: Schema.NullOr(SkillVersionId),
      local: Schema.NullOr(SkillVersionId),
    }),
  ),
});
export type SetupIntent = typeof SetupIntent.Type;

/**
 * The parts of the Library a setup can change, as one write of its record saw them: before any
 * step ran, and once it finished or stopped. Undo reverses only what changed between the two.
 */
export const RecordedLibrary = Schema.Struct({
  intent: SetupIntent,
  installedSkills: Schema.Array(InstalledSkill),
});
export type RecordedLibrary = typeof RecordedLibrary.Type;

/** Status of one recorded operation (setup, restore, undo). */
/**
 * Every status keeps its steps and their evidence: undo needs a Done or Stopped operation's
 * evidence as much as resuming needs a Pending one's.
 */
export const OperationStatus = Schema.TaggedUnion({
  Pending: {
    operationId: OperationId,
    steps: Schema.Array(RecordedSetupStep),
    before: RecordedLibrary,
  },
  Done: {
    operationId: OperationId,
    steps: Schema.Array(RecordedSetupStep),
    before: RecordedLibrary,
    after: RecordedLibrary,
  },
  Stopped: {
    operationId: OperationId,
    steps: Schema.Array(RecordedSetupStep),
    reason: SetupStopReason,
    before: RecordedLibrary,
    after: RecordedLibrary,
  },
});
export type OperationStatus = typeof OperationStatus.Type;
