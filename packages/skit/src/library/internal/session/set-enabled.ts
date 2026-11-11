import type * as Library from "../../library.js";
import { SetEnabledInvalid } from "../../enabled-plan.js";
import { Effect } from "effect";
import { expandSetEnabledIntent, type SetEnabledIntent } from "./set-enabled-request.js";
export type { SetEnabledIntent } from "./set-enabled-request.js";
import {
  setEnabledResults,
  SetEnabledChange,
  SetEnabledIncomplete,
} from "./set-enabled-contract.js";

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
  if (first === undefined) return yield* new SetEnabledInvalid({ reason: "nothing-selected" });
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

export { SetEnabledIncomplete } from "./set-enabled-contract.js";
