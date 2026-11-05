import { Schema } from "effect";
import { SyncConflictDetail } from "@smolai/skit-core/library/session";
export { SyncConflictDetail };

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

export const SyncPlan = Schema.Struct({
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

export const SyncResult = Schema.Struct({
  status: Schema.Literals([
    "clean",
    "push_ready",
    "pushed",
    "pull_ready",
    "pulled",
    "local_bytes_changed",
    "merge_ready",
    "merged",
    "conflicted",
    "resolution_invalid",
    "enablement_incomplete",
  ]),
  merge_base: Schema.optionalKey(Schema.Literals(["empty-first-sync", "empty-different-library"])),
  changed: Schema.optionalKey(Schema.Boolean),
  revision_id: Schema.optionalKey(Schema.String),
  snapshots: Schema.optionalKey(Schema.Number),
  hash: Schema.optionalKey(Schema.String),
  installed: Schema.optionalKey(Schema.Number),
  uninstalled: Schema.optionalKey(Schema.Number),
  collections_to_remove: Schema.optionalKey(Schema.Number),
  conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
  conflict_details: Schema.optionalKey(Schema.Array(SyncConflictDetail)),
  sync_status: Schema.optionalKey(Schema.Literals(["clean", "pulled", "pushed", "merged"])),
  enablement_issues: Schema.optionalKey(Schema.Array(Schema.String)),
  plan: Schema.optionalKey(SyncPlan),
});
export type SyncResult = typeof SyncResult.Type;

export type SyncEnabledItem = typeof SyncEnabledItem.Type;
export type SyncChange = typeof SyncChange.Type;
export type SyncPlan = typeof SyncPlan.Type;

export const syncOutputContracts = {
  librarySync: { id: "skit.library.sync.v13", schema: SyncResult },
} as const;
