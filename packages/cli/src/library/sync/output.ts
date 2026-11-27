import { AuthoredSkillIssue } from "@smolai/skit-core/library/update";
import { AuthorSyncResult } from "@smolai/skit-core/author";
import { ManageStopped, SyncStopped } from "@smolai/skit-core/library";
import { SchemaFailure } from "@smolai/skit-core/shared";
import { Cause, Config, ConfigProvider, Schema, SchemaGetter } from "effect";
import { SyncConflictDetail, SyncEnablementIssue, SyncIssue } from "@smolai/skit-core/library/sync";

import { SyncChanges as SyncPlan } from "@smolai/skit-core/library/sync";

import { RegistryFailure } from "../../registry/failures.js";
import { RegistryRequestFailure } from "../../registry/request-failures.js";

const ConfigFailure = Schema.TaggedStruct("ConfigError", { message: Schema.String }).pipe(
  Schema.decodeTo(Schema.instanceOf(Config.ConfigError), {
    decode: SchemaGetter.transform(
      ({ message }) => new Config.ConfigError(new ConfigProvider.SourceError({ message })),
    ),
    encode: SchemaGetter.transform((failure) => ({
      _tag: failure._tag,
      message: failure.cause.message,
    })),
  }),
);

const TimeoutFailure = Schema.TaggedStruct("TimeoutError", { message: Schema.String }).pipe(
  Schema.decodeTo(Schema.declare(Cause.isTimeoutError), {
    decode: SchemaGetter.transform(({ message }) => new Cause.TimeoutError(message)),
    encode: SchemaGetter.transform((failure) => ({
      _tag: failure._tag,
      message: failure.message,
    })),
  }),
);

const AuthorSyncFailure = Schema.Union([
  RegistryFailure,
  RegistryRequestFailure,
  SyncEnablementIssue.cases.InstallationFailed.fields.failure,
  ManageStopped,
  SyncStopped,
  SchemaFailure,
  ConfigFailure,
  TimeoutFailure,
]).annotate({ identifier: "AuthorWorkspaceSyncFailure" });

const AuthorWorkspaceResult = Schema.Struct({
  identity: Schema.String,
  directory: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["unconnected", "sync", "updated", "failed", "pull_ready", "pulled"]),
  sync: Schema.optionalKey(AuthorSyncResult),
  sync_failure: Schema.optionalKey(AuthorSyncFailure),
  installation_issues: Schema.optionalKey(Schema.Array(AuthoredSkillIssue)),
  installation: Schema.optionalKey(Schema.String),
  installation_failure: Schema.optionalKey(AuthorSyncFailure),
  failure: Schema.optionalKey(AuthorSyncFailure),
  revision_id: Schema.optionalKey(Schema.String),
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
  snapshots: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  hash: Schema.optionalKey(Schema.String),
  installed: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  uninstalled: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  collections_to_remove: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
  conflict_details: Schema.optionalKey(Schema.Array(SyncConflictDetail)),
  sync_status: Schema.optionalKey(Schema.Literals(["clean", "pulled", "pushed", "merged"])),
  enablement_issues: Schema.optionalKey(Schema.Array(SyncIssue)),
  plan: Schema.optionalKey(SyncPlan),
  author_workspaces: Schema.optionalKey(Schema.Array(AuthorWorkspaceResult)),
  author_inventory_failure: Schema.optionalKey(AuthorSyncFailure),
});
export type SyncResult = typeof SyncResult.Type;

export const syncOutputContracts = {
  librarySync: { id: "skit.library.sync.v11", schema: SyncResult },
} as const;
