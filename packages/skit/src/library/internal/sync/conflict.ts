import { Schema } from "effect";

/** Sync conflict facts shared by the Library planner and transport-facing results. */
export const SyncConflictDetail = Schema.Struct({
  key: Schema.String,
  message: Schema.String,
  resolution: Schema.Literals(["take-remote", "keep-enabled", "local"]),
});
export type SyncConflictDetail = typeof SyncConflictDetail.Type;
