import { Schema } from "effect";
import { Hash } from "../../../vocabulary.js";
import { CollectionId, ImportId } from "../../entity-ids.js";
import { LibraryState } from "../../library-state.js";
import { LegacySetupDiscovery } from "../../machine-settings.js";

export const UndoIntent = Schema.TaggedStruct("Undo", { operationId: Schema.NonEmptyString });
export type UndoIntent = typeof UndoIntent.Type;

export const UndoChange = Schema.Struct({
  operationId: Schema.String,
  planId: Hash,
  status: Schema.Literals(["ready", "conflicted", "already-undone"]),
  conflicts: Schema.Array(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["release-ownership", "restore", "remove-created"]),
    }),
  ),
  sourceSelections: Schema.Array(
    Schema.Struct({
      collectionId: CollectionId,
      label: Schema.String,
      fromSnapshot: Hash,
      toSnapshot: Hash,
    }),
  ),
  intentChanged: Schema.Boolean,
  next: LibraryState,
});
export type UndoChange = typeof UndoChange.Type;

/** Data only: apply verifies the state, folders, imports and legacy evidence all over again. */
export const UndoPlan = Schema.TaggedStruct("Undo", {
  intent: UndoIntent,
  baseRevision: Schema.String,
  planId: Hash,
  backupId: Schema.String.check(Schema.isUUID(4)),
  observations: Schema.Array(
    Schema.Struct({ collectionId: CollectionId, importId: ImportId, checkedAt: Schema.String }),
  ),
  change: UndoChange,
  /** A pre-split completion acknowledged both owners; a new completion acknowledges Library only. */
  settingsCompleted: Schema.Boolean,
  /** Opaque journal evidence passed to the machine owner; Library never restores it. */
  legacyDiscovery: Schema.optionalKey(LegacySetupDiscovery),
});
export type UndoPlan = typeof UndoPlan.Type;
export type UndoResult =
  | { readonly _tag: "AlreadyUndone"; readonly change: UndoChange }
  | { readonly _tag: "Undone"; readonly change: UndoChange; readonly backupId: string };
