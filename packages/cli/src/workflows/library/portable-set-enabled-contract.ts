import { HarnessName, PortableDeviceBinding, PortableRepositoryBinding } from "@smolai/skit-core";
import { Schema } from "effect";

export const PortableSetEnabledPlan = Schema.Struct({
  collection_id: PortableDeviceBinding.fields.collection_id,
  skills: Schema.Array(Schema.String),
  harnesses: Schema.Array(HarnessName),
  scope: Schema.Union([PortableDeviceBinding.fields.scope, PortableRepositoryBinding.fields.scope]),
  enabled: Schema.Boolean,
  invocation: Schema.optionalKey(Schema.String),
  changed: Schema.Boolean,
  bindings: Schema.Array(Schema.Union([PortableDeviceBinding, PortableRepositoryBinding])),
});
export type PortableSetEnabledPlan = typeof PortableSetEnabledPlan.Type;

export const PortableSetEnabledResult = PortableSetEnabledPlan.pipe(
  Schema.fieldsAssign({
    projections: Schema.Array(
      Schema.Struct({
        harness: HarnessName,
        status: Schema.Literals(["projected", "deferred"]),
      }),
    ),
  }),
);
export type PortableSetEnabledResult = typeof PortableSetEnabledResult.Type;
