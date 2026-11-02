import { Effect } from "effect";
import { Library, InstalledSkills, type LibraryState } from "@smolai/skit-core";
import { make as makeInstalledSkills } from "../install/installed-skills.js";
import { resolveLibrarySubject } from "../workflows/library/subject-resolution.js";
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
  | import("../workflows/library/subject-resolution.js").LibrarySubjectNotFound
  | import("../workflows/library/subject-resolution.js").LibrarySubjectAmbiguous
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
    const selected: Library.Intent[] = [];
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
    const installation = yield* makeInstalledSkills(routing);
    const library = yield* Library.make.pipe(
      Effect.provideService(InstalledSkills.Service, installation),
    );
    const plan = yield* library.plan(selected, { base: state });
    return {
      changes: plan.changes.filter(
        (change): change is Library.BindingChange =>
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
  const installation = yield* makeInstalledSkills(owner.configuration);
  const library = yield* Library.make.pipe(
    Effect.provideService(InstalledSkills.Service, installation),
  );
  const outcome = yield* library.apply(owner.plan);
  const results = outcome.results.map((result, index): SetEnabledResult => {
    const { _tag, ...change } = result.change;
    const failed =
      outcome._tag === "Incomplete" &&
      outcome.reason !== "request" &&
      index === outcome.results.length - 1;
    const failure = failed ? classifyFailure(outcome.cause) : undefined;
    return {
      ...change,
      installed_skills: result.installedSkills.flatMap(({ destination, path, status }) =>
        destination === "legacy" ? [] : [{ destination, path, status }],
      ),
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
