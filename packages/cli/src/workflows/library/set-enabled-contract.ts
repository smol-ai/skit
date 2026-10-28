import { Enabled, InstallScope, InvocationPolicy, InstallDestination } from "@smolai/skit-core";
import { Schema } from "effect";
import { DuplicateCopy, DuplicateScanError } from "../../projection/duplicates.js";

// The published output contract constrains every map value. Use string keys for this
// wire view: Effect 4's JSON Schema exporter otherwise opens records whose custom
// TypeID key check cannot be represented, dropping the value constraint as well.
const invocationPolicies = Schema.optionalKey(Schema.Record(Schema.String, InvocationPolicy));

export const SetEnabledChange = Schema.Struct({
  subject_id: Schema.String,
  skills: Schema.Array(Schema.String),
  scope: InstallScope,
  action: Schema.Literals(["enable", "disable"]),
  invocation: Schema.optionalKey(Schema.String),
  changed: Schema.Boolean,
  /** Nothing to save at this scope, but copies are missing, edited, or left behind and will be repaired. */
  repair: Schema.optionalKey(Schema.Boolean),
  shadows: Schema.optionalKey(Schema.Array(DuplicateCopy)),
  /**
   * Folders SKIT does not manage, already at destinations it would write. Enable manages one only
   * when it holds exactly SKIT's copy; otherwise it leaves it in place, reports it `conflicted`,
   * and exits 12.
   */
  unmanaged_destinations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ target: InstallDestination, path: Schema.String })),
  ),
  warnings: Schema.optionalKey(Schema.Array(DuplicateScanError)),
  /** Everything enabled at this scope after the change. */
  enabled: Schema.Array(Enabled),
  invocation_policies: invocationPolicies,
});
export type SetEnabledChange = typeof SetEnabledChange.Type;

export const SetEnabledResult = SetEnabledChange.pipe(
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
        target: InstallDestination,
        path: Schema.String,
        status: Schema.String,
      }),
    ),
  }),
);
export type SetEnabledResult = typeof SetEnabledResult.Type;
