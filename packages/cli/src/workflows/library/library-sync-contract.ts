import { Schema } from "effect";
import { HarnessName } from "@smolai/skit-core";

const SyncChange = Schema.Struct({
  kind: Schema.Literals(["collection", "skill", "binding"]),
  action: Schema.Literals(["add", "update", "remove"]),
  subject_id: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  label_before: Schema.optionalKey(Schema.String),
  label_after: Schema.optionalKey(Schema.String),
  harness: Schema.optionalKey(HarnessName),
  skills_before: Schema.Array(Schema.String),
  skills_after: Schema.Array(Schema.String),
  versions_before: Schema.Array(Schema.String),
  versions_after: Schema.Array(Schema.String),
  evidence_changed: Schema.Boolean,
});

const SyncPlan = Schema.Struct({
  local: Schema.Array(SyncChange),
  remote: Schema.Array(SyncChange),
});

const DeferredBinding = Schema.Struct({
  harness: HarnessName,
  skills: Schema.Array(Schema.String),
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
  deferred: Schema.optionalKey(Schema.Number),
  deferred_bindings: Schema.optionalKey(Schema.Array(DeferredBinding)),
  retired: Schema.optionalKey(Schema.Number),
  collections_to_remove: Schema.optionalKey(Schema.Number),
  conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
  plan: Schema.optionalKey(SyncPlan),
});
export type SyncResult = typeof SyncResult.Type;
