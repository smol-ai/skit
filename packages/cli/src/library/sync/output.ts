import { Schema } from "effect";
import { SyncConflictDetail } from "@smolai/skit-core/library/session";

import { SyncChanges as SyncPlan } from "@smolai/skit-core/library/session";
export { SyncPlan };

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

export const syncOutputContracts = {
  librarySync: { id: "skit.library.sync.v12", schema: SyncResult },
} as const;
