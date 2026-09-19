import { Digest } from "@smolai/skit-core";
import { Schema } from "effect";

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
  }),
);
export type UpdatePlan = typeof UpdatePlan.Type;
