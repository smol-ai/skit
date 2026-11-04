import { Effect } from "effect";
import { Library, InstalledSkills, type LibraryState } from "@smolai/skit-core";
import { resolveLibrarySubject } from "@smolai/skit-core";
import {
  expandSetEnabledIntent,
  type SetEnabledIntent,
} from "../workflows/library/set-enabled-request.js";
import { libraryView } from "./library-view.js";
import {
  SetEnabledIncomplete,
  type SetEnabledConfiguration,
  type SetEnabledPlan,
} from "./set-enabled.js";
import type { SetEnabledResult } from "../workflows/library/set-enabled-contract.js";
import { classifyFailure } from "../failure-classification.js";

/** Text and displayed names are resolved here; Library accepts only stable identities. */
export type SelectionError =
  | Library.PlanError
  | import("@smolai/skit-core").LibrarySubjectNotFound
  | import("@smolai/skit-core").LibrarySubjectAmbiguous
  | import("../workflows/failures.js").OptionCombinationInvalid;
export type SelectionRequirements =
  | import("@smolai/skit-core").TreeRequirements
  | import("@smolai/skit-core").TreeHasher
  | import("@smolai/skit-core").LibraryStore
  | import("../configuration/skit-configuration.js").SkitConfiguration
  | import("effect/crypto").Digest.Digest;
export interface LibraryChangeSelection {
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
): LibraryChangeSelection {
  const state = structuredClone(current);
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
    const routing = {
      home: configuration.home,
      configHome: configuration.configHome,
      overrides: structuredClone(configuration.overrides),
    };
    const installation = yield* InstalledSkills.make(routing);
    const library = yield* Library.make.pipe(
      Effect.provideService(InstalledSkills.Service, installation),
    );
    const [first, ...rest] = selected;
    if (first === undefined)
      return yield* new Library.InvalidIntent({ detail: "Choose something to enable or disable" });
    const plan = yield* library.plan(
      { _tag: "Enabled", changes: [first, ...rest] },
      {
        base: state,
        approvals: intents.flatMap((intent) =>
          intent.manage === undefined ? [] : [{ _tag: "Manage" as const, manage: intent.manage }],
        ),
      },
    );
    return {
      changes: plan.changes.filter(
        (change): change is Library.EnabledChange =>
          change._tag === "Enable" || change._tag === "Disable",
      ),
      owner: { plan, configuration: routing },
    };
  });
  return {
    state,
    view: libraryView(state, originalsPath),
    planMany,
    plan: (intent: SetEnabledIntent, configuration: SetEnabledConfiguration) =>
      planMany([intent], configuration),
  };
}

/** Published CLI output/error compatibility ends here; owner partial outcomes are values. */
export const applyLibraryChange = Effect.fn("LibrarySelection.apply")(function* (
  owner: NonNullable<SetEnabledPlan["owner"]>,
): Effect.fn.Return<
  Array<{ kind: "applied"; value: SetEnabledResult }>,
  Library.ApplyError | SetEnabledIncomplete,
  SelectionRequirements
> {
  const installation = yield* InstalledSkills.make(owner.configuration);
  const library = yield* Library.make.pipe(
    Effect.provideService(InstalledSkills.Service, installation),
  );
  const outcome = yield* library.apply(owner.plan);
  const results = outcome.results.map((result, index): SetEnabledResult => {
    const { _tag, ...change } = result.change;
    // Incomplete where it left paths unresolved; else the last one carries the failure.
    const failed =
      outcome._tag === "Incomplete" &&
      (result.unresolved.length > 0 ||
        (index === outcome.results.length - 1 &&
          outcome.results.every((other) => other.unresolved.length === 0)));
    const failure = failed ? classifyFailure(outcome.cause) : undefined;
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
