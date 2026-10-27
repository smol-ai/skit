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
  /** An unchanged Binding whose copies are missing, edited, or left behind and will be repaired. */
  repair: Schema.optionalKey(Schema.Boolean),
  shadows: Schema.optionalKey(Schema.Array(HarnessShadow)),
  /**
   * Folders SKIT does not manage, already at destinations it would write. Enable adopts one only
   * when it holds exactly SKIT's copy; otherwise it leaves it in place, reports it `conflicted`,
   * and exits 12.
   */
  unmanaged_destinations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ target: ProjectionTarget, path: Schema.String })),
  ),
  warnings: Schema.optionalKey(Schema.Array(ShadowObservationError)),
  bindings: Schema.Array(Schema.Union([deviceBindingOutput, repositoryBindingOutput])),
});
export type SetEnabledPlan = typeof SetEnabledPlan.Type;

export const SetEnabledResult = SetEnabledPlan.pipe(
  Schema.fieldsAssign({
    application: Schema.Struct({
      intent: Schema.Literals(["saved", "unchanged"]),
      revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      status: Schema.Literals(["complete", "incomplete"]),
      failure: Schema.optionalKey(
        Schema.Struct({
          code: Schema.String,
          message: Schema.String,
          remediation: Schema.String,
        }),
      ),
    }),
    /**
     * Every copy of the changed skills at this scope after the change, with its status. A
     * `conflicted` copy is a folder SKIT found at its destination and did not overwrite.
     */
    projections: Schema.Array(
      Schema.Struct({
        target: ProjectionTarget,
        path: Schema.String,
        status: Schema.String,
      }),
    ),
  }),
);
export type SetEnabledResult = typeof SetEnabledResult.Type;
