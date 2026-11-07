import type * as Library from "../../library.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import { Effect, Schema } from "effect";
import { expandSetEnabledIntent, type SetEnabledIntent } from "./set-enabled-request.js";
export type { SetEnabledIntent } from "./set-enabled-request.js";
import { failureDetails } from "../../../shared/failure.js";
import { setEnabledResults, SetEnabledChange, SetEnabledResult } from "./set-enabled-contract.js";

import { emptyLibraryState } from "../../library-state.js";
import type { Snapshot } from "../../snapshot.js";
import { resolveLibrarySubject } from "../../subject-resolution.js";
import { enabledSkillIds } from "../../library-contracts.js";
import { globalEnabled } from "../../enabled.js";

/** A reviewed change contains data only. Call apply on the Library that planned it. */
export interface SetEnabledPlan {
  readonly plan: Extract<Library.Plan, { readonly _tag: "Enabled" }>;
  readonly changes: readonly (Omit<SetEnabledChange, "invocation"> & {
    readonly invocation?: import("./invocation-option.js").InvocationOption;
    readonly listingSize: number;
  })[];
}

/** Accepted intent survives a later failure; callers must not mistake this for rejection. */
export class SetEnabledIncomplete
  extends Schema.TaggedError<SetEnabledIncomplete, { readonly brand: unique symbol }>()(
    "Library.SetEnabledIncomplete",
    {
      results: Schema.Array(SetEnabledResult),
      reason: Schema.Literals(["destinations", "update"]),
      failure: Schema.Unknown,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  get code() {
    return failureDetails(this.failure).code;
  }
  get message() {
    return `Binding intent was saved or already in place, but the operation did not complete. ${failureDetails(this.failure).message}`;
  }
  readonly remediation =
    "Inspect the saved bindings and installed copies, resolve the reported condition, then preview and retry the change. No binding rollback was attempted.";
}

/** Resolve names and member choices against the explicitly reviewed snapshot. */
export const planEnabled = Effect.fn("Library.planEnabled")(function* (
  library: Pick<Library.Interface, "plan">,
  intents: readonly SetEnabledIntent[],
  options: { readonly base: Snapshot },
) {
  const snapshot = structuredClone(options.base);
  const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
  const selected: Library.Enabled["changes"][number][] = [];
  for (const intent of intents) {
    // Preserve frontend option errors before converting member names to IDs.
    yield* expandSetEnabledIntent(state, intent);
    const subject = yield* resolveLibrarySubject(state, intent.subject);
    selected.push({
      _tag: intent.enabled ? "Enable" : "Disable",
      subject:
        subject.kind === "collection"
          ? { _tag: "Collection", id: subject.collection.collection_id }
          : { _tag: "Skill", id: subject.skill.skill_id },
      ...(intent.members === undefined
        ? {}
        : {
            members:
              intent.members === "whole"
                ? "whole"
                : intent.members.flatMap((name) =>
                    subject.skills
                      .filter((skill) => skill.name === name)
                      .map((skill) => skill.skill_id),
                  ),
          }),
      where: intent.where,
      ...(intent.invocation === undefined ? {} : { invocation: intent.invocation }),
      ...(intent.allowDuplicate === undefined ? {} : { allowDuplicate: intent.allowDuplicate }),
      ...(intent.setup === undefined ? {} : { setup: intent.setup }),
    });
  }
  const [first, ...rest] = selected;
  if (first === undefined)
    return yield* new InvalidIntent({
      detail: "Choose something to enable or disable",
    });
  const plan = yield* library.plan(
    { _tag: "Enabled", changes: [first, ...rest] },
    {
      base: snapshot,
      approvals: intents.flatMap((intent) =>
        intent.manage === undefined ? [] : [{ _tag: "Manage" as const, manage: intent.manage }],
      ),
    },
  );
  const prepared: SetEnabledPlan = {
    plan,
    changes: plan.changes.flatMap((change) =>
      change._tag === "Enable" || change._tag === "Disable"
        ? [
            {
              ...change,
              listingSize: new Set([
                ...enabledSkillIds(state, change.enabled),
                ...(change.scope.kind === "repository"
                  ? enabledSkillIds(state, globalEnabled(state).enabled)
                  : []),
              ]).size,
            },
          ]
        : [],
    ),
  };
  return prepared;
});

/** Convert an application result to the published enable/disable outcomes. Does not write. */
export const setEnabledOutcomes = Effect.fn("SetEnabled.outcomes")(function* (
  outcome: import("../../library-plan.js").Outcome,
) {
  const results = setEnabledResults(outcome);
  if (outcome._tag === "Incomplete")
    return yield* new SetEnabledIncomplete({
      results,
      reason: outcome.reason,
      failure: outcome.cause,
    });
  return results.map((value) => ({ kind: "applied" as const, value }));
});
