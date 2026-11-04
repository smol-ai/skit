import { join } from "node:path";
import { Library } from "../../library.js";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import { Effect, Schema } from "effect";
import { type InventoryRootOptions } from "../../routing/roots.js";
import { libraryChangeSelection, applyLibraryChange } from "./library-changes.js";
import type { SetEnabledIntent, SetEnabledRequest } from "./set-enabled-request.js";
export type {
  SetEnabledIntent,
  SetEnabledRequest,
  EnabledCollection,
} from "./set-enabled-request.js";
import { failureDetails } from "../../../shared/failure.js";
import { SetEnabledChange, SetEnabledResult } from "./set-enabled-contract.js";

export type SetEnabledConfiguration = InventoryRootOptions;

/** Display facts plus the Library owner's plain plan for the exact intents and Library previewed. */
export const planOwner = Symbol("LibrarySelection.owner");

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

export const SetEnabledStale = Library.StalePlan;
export type SetEnabledStale = Library.StalePlan;

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
  return yield* applyLibraryChange(home, plan);
});
