import { TreeErrorReason } from "../shared/tree-error.js";
import { Schema } from "effect";
import { Hash } from "../shared/hash.js";
import { CollectionId, SkillId } from "./entity-ids.js";
import { DiscoveryRestoreConflict } from "./machine-settings-conflicts.js";

export const UndoScope = Schema.TaggedUnion({
  Account: {},
  Device: {},
  Repository: { root: Schema.String },
}).annotate({ identifier: "UndoScope" });
export type UndoScope = typeof UndoScope.Type;

export const UndoConflict = Schema.Union([
  DiscoveryRestoreConflict,
  Schema.TaggedUnion({
    UnsupportedOperation: { kind: Schema.Literals(["recovery", "apply", "sync", "pending"]) },
    SelectionChanged: {
      scope: UndoScope,
      key: Schema.String,
      kind: Schema.Literals(["enabled", "invocation"]),
    },
    SelectionMissing: { scope: UndoScope, key: Schema.String },
    DeviceModeChanged: {},
    DeviceSelectionChanged: {},
    SkillVersionChanged: { skillId: SkillId },
    SkillMissing: { skillId: SkillId },
    CollectionMembershipChanged: { collectionId: CollectionId },
    SourceChanged: { collectionId: CollectionId },
    SourceEvidenceMissing: { collectionId: CollectionId },
    SourceBytesChanged: { collectionId: CollectionId },
    ImportAlreadyRecorded: { collectionId: CollectionId },
    ClockNotAdvanced: { collectionId: CollectionId },
    OwnershipUnconfirmed: { path: Schema.String },
    PathProtected: { path: Schema.String },
    ParentChanged: { path: Schema.String },
    StorageOverlap: { path: Schema.String },
    OriginalPathsOverlap: { path: Schema.String },
    InstalledChoiceChanged: { path: Schema.String },
    OriginalEdited: { path: Schema.String },
    DestinationOccupied: { path: Schema.String },
    CopyMissing: { path: Schema.String },
    OriginalBytesMissing: { path: Schema.String },
    DifferentDevice: { path: Schema.String },
  }),
]).annotate({ identifier: "UndoConflict" });
export type UndoConflict = typeof UndoConflict.Type;

export const RecoveryFactReason = Schema.Literals([
  "parent-changed",
  "saved",
  "at-original",
  "missing",
  "destination-occupied",
  "entry-changed",
]);
export type RecoveryFactReason = typeof RecoveryFactReason.Type;
export const RecoveryFact = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  recoveryPath: Schema.String,
  type: Schema.Literals(["Directory", "SymbolicLink"]),
  status: Schema.Literals(["saved", "at-original", "missing", "conflict"]),
  reason: RecoveryFactReason,
});
export const RecoveryInspection = Schema.Struct({
  operationId: Schema.String,
  directory: Schema.String,
  planId: Hash,
  entries: Schema.Array(RecoveryFact),
  legacy: Schema.Boolean,
});
export type RecoveryInspection = typeof RecoveryInspection.Type;

export const RecoveryReason = Schema.TaggedUnion({
  InvalidTree: { reason: TreeErrorReason },
  InvalidData: {
    record: Schema.Literals([
      "operation-directory",
      "operation-id",
      "move-record",
      "move-entry",
      "restore-review",
      "setup-evidence",
      "setup-record",
      "undo-plan",
    ]),
    path: Schema.optionalKey(Schema.String),
  },
  MissingRecord: {
    record: Schema.Literals([
      "undo-record",
      "undo-files",
      "file-evidence",
      "action-evidence",
      "ownership-evidence",
      "source-evidence",
      "reconstruction-evidence",
      "reconstruction-owner",
      "undo-file",
      "original-marker",
      "marker-metadata",
      "successor",
    ]),
    at: Schema.optionalKey(Schema.String),
  },
  UnsafePath: {
    kind: Schema.Literals([
      "operation-directory",
      "overlapping-entries",
      "library-storage",
      "recovery-storage",
      "recovery-directory",
      "move-record",
      "archive",
      "original-parent",
      "original-parent-missing",
      "parent",
      "ownership-marker",
      "undo-staging",
      "missing-parent",
    ]),
    path: Schema.String,
  },
  ContentChanged: {
    kind: Schema.Literals([
      "undo-source",
      "recovery-copy",
      "reconstruction-source",
      "reconstruction",
      "restoration",
    ]),
    path: Schema.optionalKey(Schema.String),
  },
  Conflicts: { conflicts: Schema.Array(UndoConflict) },
});
