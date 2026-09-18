import { Schema } from "effect";

export const AuthorVisibility = Schema.Literals(["private", "unlisted", "public"]);
export type AuthorVisibility = typeof AuthorVisibility.Type;

const AuthorIdentity = Schema.Struct({
  authority: Schema.String,
  namespace: Schema.String,
  skit: Schema.String,
  ref: Schema.String,
});

const SyncConflict = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["both_modified", "delete_modify", "binary", "descriptor"]),
});

const syncResult = <const Status extends string, const Fields extends Schema.Struct.Fields>(
  status: Status,
  fields: Fields,
) => Schema.Struct({ status: Schema.Literal(status), changed: Schema.Boolean, ...fields });

export const AuthorSyncResult = Schema.Union([
  syncResult("first_sync_ready", {
    identity: AuthorIdentity,
    visibility: AuthorVisibility,
    file_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    effects: Schema.Array(Schema.Literals(["create_skit", "create_draft", "record_remote_home"])),
  }),
  syncResult("created", {
    identity: AuthorIdentity,
    visibility: AuthorVisibility,
    revision_id: Schema.String,
    paths: Schema.Array(Schema.String),
    remote_home_recorded: Schema.Boolean,
    published: Schema.Boolean,
  }),
  syncResult("bound", { revision_id: Schema.String }),
  syncResult("clean", { revision_id: Schema.String }),
  syncResult("merge_ready", { paths: Schema.Array(Schema.String) }),
  syncResult("merged", {
    revision_id: Schema.String,
    paths: Schema.Array(Schema.String),
  }),
  syncResult("conflicted", { conflicts: Schema.Array(SyncConflict) }),
  syncResult("unbound_conflict", { conflicts: Schema.Array(SyncConflict) }),
]);
export type AuthorSyncResult = typeof AuthorSyncResult.Type;
