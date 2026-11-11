import {
  FailureCode,
  FailureTypeId,
  isSkitFailure,
  type SkitFailure,
} from "../../../shared/failure.js";
import type { Outcome } from "../../library-plan.js";
import { ApplyFailure } from "../../apply-failure.js";
import { Enabled } from "../../library-contracts.js";
import { InstallScope } from "../../scope.js";
import { InvocationPolicy } from "../../../artifact/invocation-policy.js";
import { InstallDestination } from "../../../installed-skills/destination.js";
import { Schema } from "effect";
import { DuplicateCopy, DuplicateScanError } from "../../duplicates.js";
import { CollectionSource } from "../../collection-source.js";

// The published output contract constrains every map value. Use string keys for this
// wire view: Effect 4's JSON Schema exporter otherwise opens records whose custom
// TypeID key check cannot be represented, dropping the value constraint as well.
const invocationPolicies = Schema.optionalKey(Schema.Record(Schema.String, InvocationPolicy));

export const SetEnabledChange = Schema.Struct({
  subject_id: Schema.String,
  collection_label: Schema.optionalKey(Schema.String),
  collection_source: Schema.optionalKey(CollectionSource),
  skills: Schema.Array(Schema.String),
  scope: InstallScope,
  action: Schema.Literals(["enable", "disable"]),
  invocation: Schema.optionalKey(Schema.String),
  changed: Schema.Boolean,
  /** Nothing to save at this scope, but copies are missing, edited, or left behind and will be repaired. */
  repair: Schema.optionalKey(Schema.Boolean),
  duplicates: Schema.optionalKey(Schema.Array(DuplicateCopy)),
  /**
   * Folders SKIT does not manage, already at destinations it would write. Enable manages one only
   * when it holds exactly SKIT's copy; otherwise it leaves it in place, reports it `conflicted`,
   * and exits 12.
   */
  unmanaged_destinations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ destination: InstallDestination, path: Schema.String })),
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
      failure: Schema.optionalKey(Schema.Struct({ code: FailureCode, cause: ApplyFailure })),
    }),
    /**
     * Every copy of the changed skills at this scope after the change, with its status. A
     * `conflicted` copy is a folder SKIT found at its destination and did not overwrite.
     */
    installed_skills: Schema.Array(
      Schema.Struct({
        destination: InstallDestination,
        path: Schema.String,
        status: Schema.String,
      }),
    ),
  }),
);
export type SetEnabledResult = typeof SetEnabledResult.Type;

/** Accepted intent survives a later failure; callers must not mistake this for rejection. */
export class SetEnabledIncomplete
  extends Schema.TaggedError<SetEnabledIncomplete, { readonly brand: unique symbol }>()(
    "Library.SetEnabledIncomplete",
    {
      results: Schema.Array(SetEnabledResult),
      reason: Schema.Literals(["destinations", "update"]),
      failure: ApplyFailure,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  get code() {
    return isSkitFailure(this.failure) ? this.failure.code : "OPERATION_FAILED";
  }
}

/** One shared result view preserves partial application details for every enable caller. */
export const setEnabledResults = (outcome: Outcome): SetEnabledResult[] => {
  return outcome.results.map((result): SetEnabledResult => {
    const { _tag, ...change } = result.change;
    const failure = result.failure === null ? undefined : result.failure;
    return {
      ...change,
      installed_skills: result.installedSkills.map(({ destination, path, status }) => ({
        destination,
        path,
        status,
      })),
      application: {
        intent: result.intent,
        revision: result.revision,
        status: failure === undefined ? "complete" : "incomplete",
        ...(failure === undefined
          ? {}
          : {
              failure: {
                code: isSkitFailure(failure) ? failure.code : "OPERATION_FAILED",
                cause: failure,
              },
            }),
      },
    };
  });
};
