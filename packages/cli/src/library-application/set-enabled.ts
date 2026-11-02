import {
  Library,
  LibraryStore,
  FailureTypeId,
  type SkitFailure,
  type LibraryState,
} from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import type { InventoryRootOptions } from "../install/roots.js";
import {
  libraryChangeSelection,
  applyLibraryChange,
  type LibraryChangeSelection,
} from "./library-changes.js";
import type {
  SetEnabledIntent,
  SetEnabledRequest,
} from "../workflows/library/set-enabled-request.js";
export type {
  SetEnabledIntent,
  SetEnabledRequest,
  EnabledCollection,
} from "../workflows/library/set-enabled-request.js";
import { classifyFailure } from "../failure-classification.js";
import { SetEnabledChange, SetEnabledResult } from "../workflows/library/set-enabled-contract.js";

export type SetEnabledConfiguration = InventoryRootOptions;

/** Display facts plus the Library owner's plain plan for the exact intents and Library previewed. */
export interface SetEnabledPlan {
  readonly owner: { readonly plan: Library.Plan; readonly configuration: SetEnabledConfiguration };
  readonly changes: readonly (Omit<SetEnabledChange, "invocation"> & {
    readonly invocation?: import("../invocation/policy.js").InvocationOption;
  })[];
}

export const SetEnabledStale = Library.StalePlan;
export type SetEnabledStale = Library.StalePlan;

/** Accepted intent survives a later failure; callers must not mistake this for rejection. */
export class SetEnabledIncomplete
  extends Schema.TaggedError<SetEnabledIncomplete>()("Library.SetEnabledIncomplete", {
    results: Schema.Array(SetEnabledResult),
    reason: Schema.Literals(["destinations", "reconciliation", "request"]),
    failure: Schema.Unknown,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  get code() {
    return classifyFailure(this.failure).code;
  }
  get message() {
    return `Binding intent was saved or already in place, but the operation did not complete. ${classifyFailure(this.failure).message}`;
  }
  readonly remediation =
    "Inspect the saved bindings and installed copies, resolve the reported condition, then preview and retry the change. No binding rollback was attempted.";
}

/** Internal constructor for application operations sharing one captured Library. */
export function setEnabledSession(
  current: LibraryState,
  home: string,
  originalsPath: string,
): LibraryChangeSelection {
  return libraryChangeSelection(current, home, originalsPath);
}

/** Read facts and accept intents against the Library displayed before asking questions. */
export const openSetEnabledSession = Effect.fn("SetEnabled.openSession")(function* () {
  const store = yield* LibraryStore;
  const selection = setEnabledSession(yield* store.load, store.home, store.originalsPath);
  return {
    ...selection,
    plan: (intent: SetEnabledIntent, configuration: SetEnabledConfiguration) =>
      selection.plan(intent, configuration).pipe(Effect.provideService(LibraryStore, store)),
    planMany: (intents: readonly SetEnabledIntent[], configuration: SetEnabledConfiguration) =>
      selection.planMany(intents, configuration).pipe(Effect.provideService(LibraryStore, store)),
  };
});
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
  ...(request.keepUnselectedInstalledSkills ||
  request.manage !== undefined ||
  request.allowedDuplicateSymlinks !== undefined
    ? {
        setup: {
          onlySelected: request.keepUnselectedInstalledSkills ?? false,
          ...(request.manage === undefined ? {} : { manage: request.manage }),
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
  requests: readonly SetEnabledRequest[],
  configuration: SetEnabledConfiguration,
) {
  const store = yield* LibraryStore;
  const selection = libraryChangeSelection(yield* store.load, store.home, store.originalsPath);
  return yield* selection.planMany(requests.map(intentFor), configuration);
});

/** Apply the owner's plan; partial outcomes keep their published CLI shape. */
export const applySetEnabledPlan = Effect.fn("SetEnabled.applyPlan")(function* (
  plan: SetEnabledPlan,
) {
  return yield* applyLibraryChange(plan.owner);
});
