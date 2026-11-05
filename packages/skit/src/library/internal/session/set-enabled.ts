import { join, resolve } from "node:path";
import * as Library from "../../library.js";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import { Effect, Schema } from "effect";
import { type InventoryRootOptions } from "../../routing/roots.js";
import {
  expandSetEnabledIntent,
  type SetEnabledIntent,
  type SetEnabledRequest,
} from "./set-enabled-request.js";
export type { SetEnabledIntent, SetEnabledRequest } from "./set-enabled-request.js";
import { failureDetails } from "../../../shared/failure.js";
import { setEnabledResults, SetEnabledChange, SetEnabledResult } from "./set-enabled-contract.js";

import { canonicalJson } from "../../../shared/json.js";
import { emptyLibraryState, type LibraryState } from "../../library-state.js";
import type { Snapshot } from "../../snapshot.js";
import { resolveLibrarySubject } from "../../subject-resolution.js";
import { libraryView } from "./library-view.js";

export type SetEnabledConfiguration = InventoryRootOptions;

/** Display facts plus the Library owner's plain plan for the exact intents and Library previewed. */
const planOwner = Symbol("LibrarySelection.owner");

export interface SetEnabledPlan {
  readonly [planOwner]: Library.Interface;
  readonly owner: {
    readonly home: string;
    readonly plan: Library.Plan;
    readonly configuration: SetEnabledConfiguration;
  };
  readonly changes: readonly (Omit<SetEnabledChange, "invocation"> & {
    readonly invocation?: import("./invocation-option.js").InvocationOption;
  })[];
}

/** Accepted intent survives a later failure; callers must not mistake this for rejection. */
export class SetEnabledIncomplete
  extends Schema.TaggedError<SetEnabledIncomplete>()("Library.SetEnabledIncomplete", {
    results: Schema.Array(SetEnabledResult),
    reason: Schema.Literals(["destinations", "update"]),
    failure: Schema.Unknown,
  })
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

/** Text and displayed names are resolved here; Library accepts only stable identities. */
export type SelectionError =
  | Library.PlanError
  | import("../../store/library-store.js").LibraryLayerError
  | import("../../subject-resolution.js").LibrarySubjectNotFound
  | import("../../subject-resolution.js").LibrarySubjectAmbiguous
  | import("../../../shared/input-failures.js").OptionCombinationInvalid;
type SelectionRequirements = never;
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
function libraryChangeSelection(
  current: Snapshot,
  home: string,
  originalsPath: string,
  library: Library.Interface,
  configuration: SetEnabledConfiguration,
): LibraryChangeSelection {
  const snapshot = structuredClone(current);
  const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
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
        base: snapshot,
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

/** Initialize the configured owner once, then capture the Library before asking questions. */
export const openSetEnabledSession = Effect.fn("Library.openSelection")(
  function* (home: string, configuration: SetEnabledConfiguration) {
    const snapshot = yield* (yield* Library.Service).read;
    return libraryChangeSelection(
      snapshot,
      home,
      join(home, "originals"),
      yield* Library.Service,
      configuration,
    );
  },
  (effect, home, configuration) =>
    Effect.scoped(effect).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "Configured", ...configuration } })),
    ),
);
export type SetEnabledSession = Effect.Success<ReturnType<typeof openSetEnabledSession>>;

/** One request in front-end terms: its subject is text, resolved against the Library planned. */
const intentFor = (request: SetEnabledRequest): SetEnabledIntent => ({
  subject: request.query,
  enabled: request.enabled,
  ...(request.all
    ? { members: "whole" as const }
    : request.selectedSkills === undefined
      ? {}
      : { members: request.selectedSkills }),
  where: [request.scope],
  ...(request.invocation === undefined ? {} : { invocation: request.invocation }),
  ...(request.allowDuplicate === undefined ? {} : { allowDuplicate: request.allowDuplicate }),
  ...(request.manage === undefined ? {} : { manage: request.manage }),
  ...(request.allowedDuplicateSymlinks !== undefined
    ? {
        setup: {
          approvedSymlinks: (request.allowedDuplicateSymlinks ?? []).map((link) => ({
            path: link.path,
            canonicalPath: link.canonicalPath,
            dev: String(link.dev),
            ino: String(link.ino),
            ...(link.linkTarget === undefined ? {} : { linkTarget: link.linkTarget }),
          })),
        },
      }
    : {}),
});

/** Internal managing/testing entry point; front ends use a held selection and user intent. */
export const planSetEnabled = Effect.fn("SetEnabled.plan")(function* (
  home: string,
  requests: readonly SetEnabledRequest[],
  configuration: SetEnabledConfiguration,
) {
  const selection = yield* openSetEnabledSession(home, configuration);
  return yield* selection.planMany(requests.map(intentFor), configuration);
});

/** Apply the owner's plan; partial outcomes keep their published CLI shape. */
export const applySetEnabledPlan = Effect.fn("SetEnabled.applyPlan")(function* (
  home: string,
  plan: SetEnabledPlan,
) {
  if (resolve(home) !== resolve(plan.owner.home) || plan[planOwner] === undefined)
    return yield* new Library.StalePlan({
      message: "This plan belongs to another Library selection",
    });
  const outcome = (yield* plan[planOwner].apply({ _tag: "Apply", plan: plan.owner.plan })).result;
  const results = setEnabledResults(outcome);
  if (outcome._tag === "Incomplete")
    return yield* new SetEnabledIncomplete({
      results,
      reason: outcome.reason,
      failure: outcome.cause,
    });
  return results.map((value) => ({ kind: "applied" as const, value }));
});
