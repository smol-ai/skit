import { Schema } from "effect";

export const SyncEnabledItem = Schema.Struct({
  kind: Schema.Literals(["collection", "skill"]),
  label: Schema.String,
});

export const SyncChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("collection"),
    action: Schema.Literals(["add", "update", "remove"]),
    subject_id: Schema.String,
    label: Schema.String,
    label_before: Schema.optionalKey(Schema.String),
    label_after: Schema.optionalKey(Schema.String),
    skills_added: Schema.Array(Schema.String),
    skills_removed: Schema.Array(Schema.String),
    skills_changed: Schema.Array(Schema.String),
    /** Only fetch records or retained evidence differ; no Skill changes. */
    evidence_only: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("enabled"),
    action: Schema.Literals(["add", "update", "remove"]),
    /** Items this change enables and disables: a whole Collection or one Skill. */
    items_added: Schema.Array(SyncEnabledItem),
    items_removed: Schema.Array(SyncEnabledItem),
  }),
]);

export const SyncChanges = Schema.Struct({
  enabled_resolution: Schema.optionalKey(
    Schema.Struct({
      winner: Schema.Literal("local"),
      collections: Schema.Array(
        Schema.Struct({ collection_id: Schema.String, label: Schema.String }),
      ),
    }),
  ),
  local: Schema.Array(SyncChange),
  remote: Schema.Array(SyncChange),
});

export type SyncEnabledItem = typeof SyncEnabledItem.Type;
export type SyncChange = typeof SyncChange.Type;
export type SyncChanges = typeof SyncChanges.Type;
