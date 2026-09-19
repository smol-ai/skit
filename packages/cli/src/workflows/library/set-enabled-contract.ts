import { HarnessName, DeviceBinding, RepositoryBinding } from "@smolai/skit-core";
import { Schema } from "effect";

export const SetEnabledPlan = Schema.Struct({
  subject_id: Schema.String,
  skills: Schema.Array(Schema.String),
  harnesses: Schema.Array(HarnessName),
  scope: Schema.Union([DeviceBinding.fields.scope, RepositoryBinding.fields.scope]),
  enabled: Schema.Boolean,
  invocation: Schema.optionalKey(Schema.String),
  changed: Schema.Boolean,
  bindings: Schema.Array(Schema.Union([DeviceBinding, RepositoryBinding])),
});
export type SetEnabledPlan = typeof SetEnabledPlan.Type;

export const SetEnabledResult = SetEnabledPlan.pipe(
  Schema.fieldsAssign({
    projections: Schema.Array(
      Schema.Struct({
        harness: HarnessName,
        status: Schema.Literals(["projected", "deferred"]),
      }),
    ),
  }),
);
export type SetEnabledResult = typeof SetEnabledResult.Type;
