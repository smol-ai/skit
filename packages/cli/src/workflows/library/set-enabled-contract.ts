import {
  DeviceBinding,
  InvocationPolicy,
  ProjectionTarget,
  RepositoryBinding,
} from "@smolai/skit-core";
import { Schema } from "effect";

import { HarnessShadow, ShadowObservationError } from "../../projection/harness-shadows.js";

// The published output contract constrains every map value. Use string keys for this
// wire view: Effect 4's JSON Schema exporter otherwise opens records whose custom
// TypeID key check cannot be represented, dropping the value constraint as well.
const invocationPolicies = Schema.optionalKey(Schema.Record(Schema.String, InvocationPolicy));
const deviceBindingOutput = DeviceBinding.pipe(
  Schema.fieldsAssign({ invocation_policies: invocationPolicies }),
);
const repositoryBindingOutput = RepositoryBinding.pipe(
  Schema.fieldsAssign({ invocation_policies: invocationPolicies }),
);

export const SetEnabledPlan = Schema.Struct({
  subject_id: Schema.String,
  skills: Schema.Array(Schema.String),
  scope: Schema.Union([DeviceBinding.fields.scope, RepositoryBinding.fields.scope]),
  enabled: Schema.Boolean,
  invocation: Schema.optionalKey(Schema.String),
  changed: Schema.Boolean,
  shadows: Schema.optionalKey(Schema.Array(HarnessShadow)),
  warnings: Schema.optionalKey(Schema.Array(ShadowObservationError)),
  bindings: Schema.Array(Schema.Union([deviceBindingOutput, repositoryBindingOutput])),
});
export type SetEnabledPlan = typeof SetEnabledPlan.Type;

export const SetEnabledResult = SetEnabledPlan.pipe(
  Schema.fieldsAssign({
    /** Each target this change materialized; `.claude` appears only when Claude Code is present. */
    projections: Schema.Array(Schema.Struct({ target: ProjectionTarget })),
  }),
);
export type SetEnabledResult = typeof SetEnabledResult.Type;
