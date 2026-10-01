import { Schema } from "effect";

const SyncBindingEntry = Schema.Struct({
  kind: Schema.Literals(["collection", "skill"]),
  label: Schema.String,
});

const SyncChange = Schema.Union([
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
    kind: Schema.Literal("binding"),
    action: Schema.Literals(["add", "update", "remove"]),
    /** Entries this change enables and disables: a whole Collection or one Skill. */
    entries_added: Schema.Array(SyncBindingEntry),
    entries_removed: Schema.Array(SyncBindingEntry),
  }),
]);

const SyncPlan = Schema.Struct({
  local: Schema.Array(SyncChange),
  remote: Schema.Array(SyncChange),
});

export const SyncResult = Schema.Struct({
  status: Schema.Literals([
    "clean",
    "push_ready",
    "pushed",
    "pull_ready",
    "pulled",
    "upgrade_ready",
    "upgraded",
    "legacy_remote_conflict",
    "local_migration_required",
    "local_bytes_changed",
    "adoption_required",
    "adoption_ready",
    "merge_ready",
    "merged",
    "conflicted",
    "base_mismatch",
    "resolution_invalid",
  ]),
  changed: Schema.optionalKey(Schema.Boolean),
  revision_id: Schema.optionalKey(Schema.String),
  snapshots: Schema.optionalKey(Schema.Number),
  digest: Schema.optionalKey(Schema.String),
  projection_drift: Schema.optionalKey(Schema.Array(Schema.String)),
  projected: Schema.optionalKey(Schema.Number),
  retired: Schema.optionalKey(Schema.Number),
  collections_to_remove: Schema.optionalKey(Schema.Number),
  conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
  plan: Schema.optionalKey(SyncPlan),
});
export type SyncResult = typeof SyncResult.Type;
