import { Revision } from "../../snapshot.js";
import { Schema } from "effect";
import { Hash } from "../../../shared/hash.js";
import { CollectionId, ImportId } from "../../entity-ids.js";
import { LibraryState } from "../../library-state.js";

export const UndoIntent = Schema.TaggedStruct("Undo", { operationId: Schema.NonEmptyString });
export type UndoIntent = typeof UndoIntent.Type;

const UndoChange = Schema.Struct({
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
type UndoChange = typeof UndoChange.Type;

/** Data only: apply verifies the state, folders and imports all over again. */
export const UndoPlan = Schema.TaggedStruct("Undo", {
  intent: UndoIntent,
  baseRevision: Revision,
  planId: Hash,
  backupId: Schema.String.check(Schema.isUUID(4)),
  observations: Schema.Array(
    Schema.Struct({ collectionId: CollectionId, importId: ImportId, checkedAt: Schema.String }),
  ),
  change: UndoChange,
});
export type UndoPlan = typeof UndoPlan.Type;
export type UndoResult =
  | { readonly _tag: "AlreadyUndone"; readonly change: UndoChange }
  | { readonly _tag: "Undone"; readonly change: UndoChange; readonly backupId: string };
