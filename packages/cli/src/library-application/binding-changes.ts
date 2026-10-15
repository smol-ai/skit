import {
  bindingSkillIds,
  LinkStat,
  deterministicTreeHashEffect,
  DeviceBinding,
  RepositoryBinding,
  lastPublishedLibraryState,
  LibraryStore,
  libraryStateRevision,
  withLibraryWriter,
  FailureTypeId,
  type SkitFailure,
  type LibraryState,
  type Digest,
} from "@smolai/skit-core";
import { Data, Effect, FileSystem } from "effect";
import { resolve } from "node:path";
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
import { resolveLibrarySubject } from "../workflows/library/subject-resolution.js";
import {
  calculateBindingChange,
  scopeBinding,
  type BindingSelection,
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
  readonly adoption?: { readonly path: string; readonly observedHash: Digest };
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

const isDeviceBinding = (binding: DeviceBinding | RepositoryBinding): binding is DeviceBinding =>
  binding.scope.kind === "global";

const previewChange = Effect.fn("LibraryBindings.previewChange")(function* (
  state: LibraryState,
  options: BindingChangeRequest,
  configuration: BindingChangeConfiguration,
) {
  const { plan, skillIds, newlyEnabledSkills } = yield* calculateBindingChange(state, options);
  const { scope, bindings, changed } = plan;
  const warnings: ShadowObservationError[] = [];
  const shadows = newlyEnabledSkills.length
    ? yield* observeHarnessShadows(configuration, scope, newlyEnabledSkills, warnings)
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

/** Keep interactive selection tied to the Library shown before asking questions. */
export const openBindingChangeSelection = Effect.fn("LibraryBindings.openSelection")(function* (
  configuration: BindingChangeConfiguration,
) {
  const store = yield* LibraryStore;
  const current = yield* store.load;
  const home = store.home;
  const revision = libraryStateRevision(current);
  // Copy only supported fields; embedders may carry unrelated functions alongside them.
  const routing = {
    home: configuration.home,
    configHome: configuration.configHome,
    overrides: structuredClone(configuration.overrides),
  };
  return {
    library: structuredClone(current),
    originalsPath: store.originalsPath,
    preview: Effect.fn("LibraryBindings.previewSelection")(function* (
      requests: readonly BindingChangeRequest[],
    ) {
      const prepared = {
        home,
        revision,
        requests: structuredClone(requests),
        configuration: routing,
      };
      const changes = yield* Effect.forEach(prepared.requests, (request) =>
        previewChange(current, request, routing),
      );
      const plan: BindingChangePlan = { [planType]: true, changes };
      preparedPlans.set(plan, prepared);
      return plan;
    }),
  };
});

/** Observe without holding a writer or materializing any Projection. */
export const previewBindingChanges = Effect.fn("LibraryBindings.preview")(function* (
  requests: readonly BindingChangeRequest[],
  configuration: BindingChangeConfiguration,
) {
  const selection = yield* openBindingChangeSelection(configuration);
  return yield* selection.preview(requests);
});

/** Authoritatively reload, commit Binding intent, then reconcile Projection reality. */
const applyChange = Effect.fn("LibraryBindings.applyChange")(function* (
  state: LibraryState,
  options: BindingChangeRequest,
  configuration: BindingChangeConfiguration,
) {
  const plan = yield* previewChange(state, options, configuration);
  const expectedRevision = libraryStateRevision(state);
  const store = yield* LibraryStore;
  const current = yield* store.load;
  if (libraryStateRevision(current) !== expectedRevision) return yield* stale();
  if (options.enabled && !options.allowDuplicate) {
    const selected = yield* resolveLibrarySubject(current, options.query);
    const existing = scopeBinding(current, plan.scope);
    const existingIds = new Set(existing ? bindingSkillIds(current, existing) : []);
    const newlyEnabled = selected.skills.filter(
      (skill) => plan.skills.includes(skill.name) && !existingIds.has(skill.skill_id),
    );
    const shadows = newlyEnabled.length
      ? yield* observeHarnessShadows(
          configuration,
          plan.scope,
          newlyEnabled.map((skill) => skill.name),
        )
      : [];
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
  if (plan.changed) {
    const global_bindings = [...current.global_bindings];
    const local_bindings = [...current.local_bindings];
    for (const binding of plan.bindings) {
      if (isDeviceBinding(binding)) global_bindings.splice(0, global_bindings.length, binding);
      else {
        const index = local_bindings.findIndex(
          (item) => resolve(item.scope.root) === resolve(binding.scope.root),
        );
        if (index < 0) local_bindings.push(binding);
        else local_bindings[index] = binding;
      }
    }
    // Publishing onto `current`, the previewed revision, makes the check above atomic.
    yield* store
      .publish({ ...current, global_bindings, local_bindings }, current)
      .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(stale())));
  }
  const selected = yield* resolveLibrarySubject(current, options.query);
  const reconciled = yield* reconcileLibraryProjections({
    roots: configuration,
    variantsPath: store.variantsPath,
    onlyBindings: plan.bindings,
    restoreNativeDeletedSkills: options.enabled
      ? selected.skills
          .filter((skill) => plan.skills.includes(skill.name))
          .map((skill) => skill.skill_id)
      : [],
    ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
  });
  let result = plan;
  if (!options.enabled) {
    const settled = yield* store.load;
    const global_bindings = settled.global_bindings.filter((binding) => binding.entries.length > 0);
    const local_bindings = settled.local_bindings.filter((binding) => binding.entries.length > 0);
    if (
      global_bindings.length !== settled.global_bindings.length ||
      local_bindings.length !== settled.local_bindings.length
    )
      yield* store.publish({ ...settled, global_bindings, local_bindings }, settled);
    result = {
      ...plan,
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
      for (const request of prepared.requests) {
        outcomes.push(yield* applyChange(expected, request, prepared.configuration));
        expected = (yield* lastPublishedLibraryState) ?? expected;
      }
      return outcomes;
    }),
  );
});
