import {
  bindingSkillIds,
  bindingShadowCheckSkills,
  LinkStat,
  deterministicTreeHashEffect,
  ensureProjectionRootWritable,
  replaceScopeBinding,
  pruneEmptyBindings,
  lastPublishedLibraryState,
  LibraryStore,
  libraryStateRevision,
  withLibraryWriter,
  FailureTypeId,
  type SkitFailure,
  type LibraryState,
  type Digest,
  type ProjectionAdoption,
} from "@smolai/skit-core";
import { Data, Effect, FileSystem } from "effect";
import {
  activeProjectionTargetsEffect,
  bindingRoot,
  type InventoryRootOptions,
} from "../projection/roots.js";
import {
  observeHarnessShadows,
  ProjectionWouldDuplicate,
  type ShadowObservationError,
} from "../projection/harness-shadows.js";
import { reconcileLibraryProjections } from "../workflows/library/projection-reconciliation.js";
import {
  calculateBindingChange,
  expandBindingIntent,
  type BindingChangeIntent,
  type BindingSelection,
} from "../workflows/library/binding-selection.js";
import { libraryView } from "./library-view.js";
export type {
  BindingChangeIntent,
  BindingPlacement,
} from "../workflows/library/binding-selection.js";
import type { SetEnabledResult } from "../workflows/library/set-enabled-contract.js";

export interface BindingChangeRequest extends BindingSelection {
  readonly allowDuplicate?: boolean;
  /** Setup consent applies only to these exact symlinks, until projection succeeds. */
  readonly allowedShadowAliases?: readonly {
    readonly path: string;
    readonly canonicalPath: string;
    readonly dev: number;
    readonly ino: number;
    readonly linkTarget?: string;
  }[];
  readonly adoption?: ProjectionAdoption;
}

export type BindingChangeConfiguration = InventoryRootOptions;

const planType = Symbol("BindingChangePlan");
/** Display facts plus an opaque handle to the exact requests and Library previewed. */
export interface BindingChangePlan {
  readonly [planType]: true;
  readonly changes: readonly Effect.Success<ReturnType<typeof previewChange>>[];
}

const preparedPlans = new WeakMap<
  BindingChangePlan,
  {
    home: string;
    revision: string;
    requests: readonly BindingChangeRequest[];
    configuration: BindingChangeConfiguration;
    repairs: readonly boolean[];
  }
>();

export class SetEnabledStale
  extends Data.TaggedError("Library.SetEnabledStale")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the Binding change again.";
}

const stale = () =>
  new SetEnabledStale({ message: "Library changed after this Binding change was previewed" });

const previewChange = Effect.fn("LibraryBindings.previewChange")(function* (
  state: LibraryState,
  options: BindingChangeRequest,
  configuration: BindingChangeConfiguration,
) {
  const { plan, skillIds, newlyEnabledSkills } = yield* calculateBindingChange(state, options);
  const { scope, bindings, changed } = plan;
  const warnings: ShadowObservationError[] = [];
  const namesToCheck = bindingShadowCheckSkills(
    state,
    scope,
    options.enabled ? plan.skills : [],
    newlyEnabledSkills,
  );
  const shadows = namesToCheck.length
    ? yield* observeHarnessShadows(configuration, scope, namesToCheck, warnings)
    : [];
  // An unchanged Binding still repairs its copies when they are missing, edited, or left behind.
  let repair = false;
  if (!changed) {
    const fs = yield* FileSystem.FileSystem;
    const bound = bindings.map((binding) => new Set(bindingSkillIds(state, binding)));
    for (const target of yield* activeProjectionTargetsEffect(configuration)) {
      const root = bindingRoot(target, scope, configuration);
      const projections = state.projections.filter(
        (projection) => projection.root === root && projection.target === target,
      );
      if (options.enabled)
        for (const skillId of skillIds) {
          const projection = projections.find((candidate) => candidate.skill_id === skillId);
          repair ||=
            projection === undefined ||
            projection.status !== "installed" ||
            !(yield* fs.exists(projection.path)) ||
            (yield* deterministicTreeHashEffect(projection.path)) !== projection.expected_digest;
        }
      else if (bindings.length)
        for (const projection of projections)
          if (!bound.some((ids) => ids.has(projection.skill_id)))
            repair ||= yield* fs.exists(projection.path);
    }
  }
  return {
    ...plan,
    ...(shadows.length ? { shadows } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(repair ? { repair } : {}),
  };
});

/** The raw request path is retained for internal adoption workflows. */
const previewRequests = Effect.fn("LibraryBindings.previewRequests")(function* (
  current: LibraryState,
  home: string,
  requests: readonly BindingChangeRequest[],
  configuration: BindingChangeConfiguration,
) {
  const routing = {
    home: configuration.home,
    configHome: configuration.configHome,
    overrides: structuredClone(configuration.overrides),
  };
  const captured = structuredClone(requests);
  let projected = current;
  const changes = [];
  for (const request of captured) {
    const change = yield* previewChange(projected, request, routing);
    changes.push(change);
    // Later previews see earlier intent at the same Scope, just as apply does.
    for (const binding of change.bindings) projected = replaceScopeBinding(projected, binding);
  }
  const plan: BindingChangePlan = { [planType]: true, changes: structuredClone(changes) };
  preparedPlans.set(plan, {
    home,
    revision: libraryStateRevision(current),
    requests: captured,
    configuration: routing,
    repairs: changes.map((change) => change.repair === true),
  });
  return plan;
});

/** Internal constructor for application operations sharing one captured Library. */
export function bindingChangeSelection(current: LibraryState, home: string, originalsPath: string) {
  return {
    view: libraryView(current, originalsPath),
    previewMany: Effect.fn("LibraryBindings.previewSelections")(function* (
      intents: readonly BindingChangeIntent[],
      configuration: BindingChangeConfiguration,
    ) {
      const requests = yield* Effect.forEach(intents, (intent) =>
        expandBindingIntent(current, intent),
      );
      return yield* previewRequests(current, home, requests.flat(), configuration);
    }),
    preview: Effect.fn("LibraryBindings.previewSelection")(function* (
      intent: BindingChangeIntent,
      configuration: BindingChangeConfiguration,
    ) {
      const requests = yield* expandBindingIntent(current, intent);
      return yield* previewRequests(current, home, requests, configuration);
    }),
  };
}

/** Read facts and accept intents against the Library displayed before asking questions. */
export const openBindingChangeSelection = Effect.fn("LibraryBindings.openSelection")(function* () {
  const store = yield* LibraryStore;
  return bindingChangeSelection(yield* store.load, store.home, store.originalsPath);
});
export type BindingChangeSelection = Effect.Success<ReturnType<typeof openBindingChangeSelection>>;

/** Internal adoption/testing entry point; front ends use a held selection and user intent. */
export const previewBindingChanges = Effect.fn("LibraryBindings.preview")(function* (
  requests: readonly BindingChangeRequest[],
  configuration: BindingChangeConfiguration,
) {
  const store = yield* LibraryStore;
  return yield* previewRequests(yield* store.load, store.home, requests, configuration);
});

/** Authoritatively reload, commit Binding intent, then reconcile Projection reality. */
const applyChange = Effect.fn("LibraryBindings.applyChange")(function* (
  state: LibraryState,
  options: BindingChangeRequest,
  configuration: BindingChangeConfiguration,
  repair: boolean,
) {
  const expectedRevision = libraryStateRevision(state);
  const store = yield* LibraryStore;
  const current = yield* store.load;
  if (libraryStateRevision(current) !== expectedRevision) return yield* stale();
  const calculated = yield* calculateBindingChange(current, options);
  const { plan, skillIds, newlyEnabledSkills } = calculated;
  const warnings: ShadowObservationError[] = [];
  const namesToCheck = bindingShadowCheckSkills(
    current,
    plan.scope,
    options.enabled ? plan.skills : [],
    newlyEnabledSkills,
  );
  const shadows = namesToCheck.length
    ? yield* observeHarnessShadows(configuration, plan.scope, namesToCheck, warnings)
    : [];
  if (options.enabled && !options.allowDuplicate) {
    const links = yield* LinkStat;
    const fs = yield* FileSystem.FileSystem;
    const remaining = [];
    for (const shadow of shadows) {
      const aliases = [];
      for (const alias of shadow.aliases) {
        const approved = options.allowedShadowAliases?.find(
          (item) => item.path === alias.path && item.canonicalPath === shadow.canonicalPath,
        );
        if (approved) {
          const info = yield* links.identity.lstat(alias.path);
          if (
            info.type === "SymbolicLink" &&
            info.dev === approved.dev &&
            info.ino === approved.ino &&
            (yield* fs.readLink(alias.path)) === approved.linkTarget
          )
            continue;
        }
        aliases.push(alias);
      }
      if (aliases.length) remaining.push({ ...shadow, aliases });
    }
    if (remaining.length) return yield* new ProjectionWouldDuplicate({ shadows: remaining });
  }
  // A root SKIT cannot write, such as `.agents` inside Codex's sandbox, fails before the Binding is
  // published, so enabling never records intent its copies cannot follow.
  if (options.enabled)
    for (const target of yield* activeProjectionTargetsEffect(configuration))
      yield* ensureProjectionRootWritable(bindingRoot(target, plan.scope, configuration));
  if (plan.changed) {
    let next = current;
    for (const binding of plan.bindings) next = replaceScopeBinding(next, binding);
    // Publishing onto `current`, the previewed revision, makes the check above atomic.
    yield* store
      .publish(next, current)
      .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(stale())));
  }
  const reconciled = yield* reconcileLibraryProjections({
    roots: configuration,
    variantsPath: store.variantsPath,
    onlyBindings: plan.bindings,
    restoreNativeDeletedSkills: options.enabled ? skillIds : [],
    ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
  });
  let result = {
    ...plan,
    ...(repair ? { repair } : {}),
    ...(shadows.length ? { shadows } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  if (!options.enabled) {
    // Reconciliation needs empty Bindings to retire their copies; prune them only afterward.
    const settled = yield* store.load;
    const pruned = pruneEmptyBindings(settled);
    if (pruned !== settled) yield* store.publish(pruned, settled);
    result = {
      ...result,
      bindings: plan.bindings.filter((binding) => binding.entries.length > 0),
    };
  }
  return {
    kind: "applied" as const,
    value: {
      ...result,
      projections: reconciled.outcomes.map(({ target }) => ({ target })),
    },
  };
});

/** Revalidate and apply the prepared requests in order under one recording writer. */
export const applyBindingChanges = Effect.fn("LibraryBindings.apply")(function* (
  plan: BindingChangePlan,
) {
  const prepared = preparedPlans.get(plan);
  const store = yield* LibraryStore;
  if (prepared === undefined || prepared.home !== store.home) return yield* stale();
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      let expected = yield* store.load;
      if (libraryStateRevision(expected) !== prepared.revision) return yield* stale();
      const outcomes: Array<{ readonly kind: "applied"; readonly value: SetEnabledResult }> = [];
      for (const [index, request] of prepared.requests.entries()) {
        outcomes.push(
          yield* applyChange(
            expected,
            request,
            prepared.configuration,
            prepared.repairs[index] ?? false,
          ),
        );
        expected = (yield* lastPublishedLibraryState) ?? expected;
      }
      return outcomes;
    }),
  );
});
