import { Digest } from "@smolai/skit-core";
import { Schema } from "effect";

export const PortableUpdateResult = Schema.Array(
  Schema.Struct({
    collection_id: Schema.String,
    previous_retained_copy_id: Schema.String,
    selected_retained_copy_id: Schema.String,
    snapshot_digest: Digest,
    changed: Schema.Boolean,
    projected: Schema.Number,
    deferred: Schema.Number,
  }),
);
export type PortableUpdateResult = typeof PortableUpdateResult.Type;

export const PortableUpdatePlan = Schema.Array(
  Schema.Struct({
    collection_id: Schema.String,
    current_snapshot_digest: Digest,
    available_snapshot_digest: Digest,
    changed: Schema.Boolean,
  }),
);
export type PortableUpdatePlan = typeof PortableUpdatePlan.Type;
