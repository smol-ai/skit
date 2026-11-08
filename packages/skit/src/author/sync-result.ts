import { Schema } from "effect";

import { AuthorVisibility } from "./remote.js";

const AuthorIdentity = Schema.Struct({
  authority: Schema.String,
  namespace: Schema.String,
  skit: Schema.String,
  locator: Schema.String,
});

/** A conflict a merge decided, and whose version it kept. */
const SyncChoice = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["both_modified", "delete_modify", "binary", "descriptor"]),
  kept: Schema.Literals(["local", "remote"]),
});

const syncResult = <const Status extends string, const Fields extends Schema.Struct.Fields>(
  status: Status,
  fields: Fields,
) => Schema.Struct({ status: Schema.Literal(status), changed: Schema.Boolean, ...fields });

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const AuthorSyncResult = Schema.Union([
  syncResult("first_sync_ready", {
    identity: AuthorIdentity,
    visibility: AuthorVisibility,
    file_count: count,
    effects: Schema.Array(Schema.Literals(["create_skit", "save_revision", "record_remote_home"])),
  }),
  syncResult("created", {
    identity: AuthorIdentity,
    visibility: AuthorVisibility,
    revision_id: Schema.String,
    paths: Schema.Array(Schema.String),
    remote_home_recorded: Schema.Boolean,
    published: Schema.Boolean,
  }),
  /** A preview: what `--apply` would do. */
  syncResult("ready", { action: Schema.Literals(["pull", "push", "merge"]) }),
  syncResult("up_to_date", { revision_id: Schema.String }),
  syncResult("pulled", { revision_id: Schema.String, paths: Schema.Array(Schema.String) }),
  syncResult("pushed", { revision_id: Schema.String }),
  syncResult("merged", {
    revision_id: Schema.String,
    paths: Schema.Array(Schema.String),
    choices: Schema.Array(SyncChoice),
  }),
  /** Too many local deletions; `--allow-large-deletion` approves this exact removal. */
  syncResult("blocked", { deleting: count, of: count, paths: Schema.Array(Schema.String) }),
  syncResult("waiting_for_removal", {
    deleting: count,
    of: count,
    paths: Schema.Array(Schema.String),
  }),
]);
export type AuthorSyncResult = typeof AuthorSyncResult.Type;
