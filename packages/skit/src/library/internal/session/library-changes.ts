import { resolve } from "node:path";
import { canonicalJson } from "../../../shared/json.js";
import { Effect } from "effect";
import { Library } from "../../library.js";
import { type LibraryState } from "../../library-state.js";
import { resolveLibrarySubject } from "../../subject-resolution.js";
import { expandSetEnabledIntent, type SetEnabledIntent } from "./set-enabled-request.js";
import { libraryView } from "./library-view.js";
import {
  SetEnabledIncomplete,
  planOwner,
  type SetEnabledConfiguration,
  type SetEnabledPlan,
} from "./set-enabled.js";
import type { SetEnabledResult } from "./set-enabled-contract.js";
import { failureDetails } from "../../../shared/failure.js";

/** Text and displayed names are resolved here; Library accepts only stable identities. */
export type SelectionError =
  | Library.PlanError
  | import("../../store/library-store.js").LibraryStoreLayerError
  | import("../../subject-resolution.js").LibrarySubjectNotFound
  | import("../../subject-resolution.js").LibrarySubjectAmbiguous
  | import("../../../shared/input-failures.js").OptionCombinationInvalid;
export type SelectionRequirements = never;
export interface LibraryChangeSelection {
  readonly configuration: SetEnabledConfiguration;
  readonly home: string;
  readonly state: LibraryState;
  readonly view: ReturnType<typeof libraryView>;
  readonly planMany: (
    intents: readonly SetEnabledIntent[],
    configuration: SetEnabledConfiguration,
  ) => Effect.Effect<SetEnabledPlan, SelectionError, SelectionRequirements>;
  readonly plan: (
    intent: SetEnabledIntent,
    configuration: SetEnabledConfiguration,
  ) => Effect.Effect<SetEnabledPlan, SelectionError, SelectionRequirements>;
}
export function libraryChangeSelection(
  current: LibraryState,
  home: string,
  originalsPath: string,
  library: Library.Interface,
  configuration: SetEnabledConfiguration,
): LibraryChangeSelection {
  const state = structuredClone(current);
  const routing = {
    home: configuration.home,
    configHome: configuration.configHome,
    overrides: structuredClone(configuration.overrides),
  };
  const planMany = Effect.fn("LibrarySelection.plan")(function* (
    intents: readonly SetEnabledIntent[],
    configuration: SetEnabledConfiguration,
  ) {
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
    if (
      canonicalJson(routing) !==
      canonicalJson({
        home: configuration.home,
        configHome: configuration.configHome,
        overrides: configuration.overrides,
      })
    )
      return yield* new Library.StalePlan({
        message: "The install configuration changed; open a new Library selection",
      });
    const [first, ...rest] = selected;
    if (first === undefined)
      return yield* new Library.InvalidIntent({
        detail: "Choose something to enable or disable",
      });
    const plan = yield* library.plan(
      { _tag: "Enabled", changes: [first, ...rest] },
      {
        base: state,
        approvals: intents.flatMap((intent) =>
          intent.manage === undefined ? [] : [{ _tag: "Manage" as const, manage: intent.manage }],
        ),
      },
    );
    const prepared: SetEnabledPlan = {
      [planOwner]: library,
      changes: plan.changes.filter(
        (change): change is Library.EnabledChange =>
          change._tag === "Enable" || change._tag === "Disable",
      ),
      owner: { home, plan, configuration: routing },
    };
    return prepared;
  });
  return {
    configuration: routing,
    home,
    state,
    view: libraryView(state, originalsPath),
    planMany,
    plan: (intent: SetEnabledIntent, configuration: SetEnabledConfiguration) =>
      planMany([intent], configuration),
  };
}

/** Published CLI output/error compatibility ends here; owner partial outcomes are values. */
export const applyLibraryChange = Effect.fn("LibrarySelection.apply")(function* (
  home: string,
  prepared: SetEnabledPlan,
): Effect.fn.Return<
  Array<{ kind: "applied"; value: SetEnabledResult }>,
  Library.ApplyError | SetEnabledIncomplete,
  never
> {
  if (resolve(home) !== resolve(prepared.owner.home) || prepared[planOwner] === undefined)
    return yield* new Library.StalePlan({
      message: "This plan belongs to another Library selection",
    });
  const outcome = yield* prepared[planOwner].apply(prepared.owner.plan);
  const results = outcome.results.map((result, index): SetEnabledResult => {
    const { _tag, ...change } = result.change;
    // Incomplete where it left paths unresolved; else the last one carries the failure.
    const failed =
      outcome._tag === "Incomplete" &&
      (result.unresolved.length > 0 ||
        (index === outcome.results.length - 1 &&
          outcome.results.every((other) => other.unresolved.length === 0)));
    const failure = failed ? failureDetails(outcome.cause) : undefined;
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
        status: failed ? "incomplete" : "complete",
        ...(failure === undefined
          ? {}
          : {
              failure: {
                code: failure.code,
                message: failure.message,
                remediation: failure.remediation,
              },
            }),
      },
    };
  });
  if (outcome._tag === "Incomplete")
    return yield* new SetEnabledIncomplete({
      results,
      reason: outcome.reason,
      failure: outcome.cause,
    });
  return results.map((value) => ({ kind: "applied" as const, value }));
});
