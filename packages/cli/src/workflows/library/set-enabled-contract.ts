import { DeviceBinding, ProjectionTarget, RepositoryBinding } from "@smolai/skit-core";
import { Schema } from "effect";

export const SetEnabledPlan = Schema.Struct({
  subject_id: Schema.String,
  skills: Schema.Array(Schema.String),
  scope: Schema.Union([DeviceBinding.fields.scope, RepositoryBinding.fields.scope]),
  enabled: Schema.Boolean,
  invocation: Schema.optionalKey(Schema.String),
  changed: Schema.Boolean,
  bindings: Schema.Array(Schema.Union([DeviceBinding, RepositoryBinding])),
});
export type SetEnabledPlan = typeof SetEnabledPlan.Type;

export const SetEnabledResult = SetEnabledPlan.pipe(
  Schema.fieldsAssign({
    /** Each target this change materialized; `.claude` appears only when Claude Code is present. */
    projections: Schema.Array(Schema.Struct({ target: ProjectionTarget })),
  }),
);
export type SetEnabledResult = typeof SetEnabledResult.Type;
