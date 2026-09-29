import { Digest } from "@smolai/skit-core";
import { Schema } from "effect";

/** What a refresh means for the Skills this device enables. */
const SkillChanges = {
  label: Schema.String,
  /** New upstream Skills enabled because the Collection is followed. */
  enabled: Schema.Array(Schema.String),
  /** New upstream Skills nothing enables. */
  new_available: Schema.Number,
  /** Enabled Skills whose bytes changed. */
  updated: Schema.Array(Schema.String),
  /** Skills deleted upstream and retired because their Collection is followed. */
  removed: Schema.Array(Schema.String),
  /** Individually enabled Skills deleted upstream, kept at their last Version. */
  kept: Schema.Array(Schema.String),
};

export const UpdateResult = Schema.Array(
  Schema.Struct({
    subject_id: Schema.String,
    subject_kind: Schema.Literals(["collection", "skill"]),
    previous_retained_copy_id: Schema.String,
    selected_retained_copy_id: Schema.String,
    snapshot_digest: Digest,
    changed: Schema.Boolean,
    projected: Schema.Number,
    deferred: Schema.Number,
    ...SkillChanges,
  }),
);
export type UpdateResult = typeof UpdateResult.Type;

export const UpdatePlan = Schema.Array(
  Schema.Struct({
    subject_id: Schema.String,
    subject_kind: Schema.Literals(["collection", "skill"]),
    current_snapshot_digest: Digest,
    available_snapshot_digest: Digest,
    changed: Schema.Boolean,
    ...SkillChanges,
  }),
);
export type UpdatePlan = typeof UpdatePlan.Type;
