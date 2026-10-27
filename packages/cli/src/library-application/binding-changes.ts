import { join } from "node:path";
import {
  bindingSkillIds,
  skillsToCheckForDuplicates,
  LinkStat,
  deterministicTreeHash,
  ensureSkillsDirectoryWritable,
  inspectOwnershipMarker,
  installedSkillName,
  type InstallDestination,
  replaceScopeBinding,
  pruneEmptyBindings,
  lastSavedLibraryState,
  LibraryStore,
  libraryStateRevision,
  withLibraryWriter,
  FailureTypeId,
  type SkitFailure,
  type LibraryState,
  type InstalledSkillAdoption,
} from "@smolai/skit-core";
import { Data, Effect, FileSystem, Option, Result, Schema } from "effect";
import {
  activeInstallDestinationsEffect,
  bindingRoot,
  type InventoryRootOptions,
} from "../projection/roots.js";
import {
  isEntryLink,
  findDuplicates,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  type DuplicateScanError,
} from "../projection/duplicates.js";
import { updateInstalledSkills } from "../workflows/library/update-installed-skills.js";
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
import { classifyFailure } from "../failure-classification.js";
import { SetEnabledResult } from "../workflows/library/set-enabled-contract.js";

export interface BindingChangeRequest extends BindingSelection {
  /** Setup changes only its explicitly selected subjects, preserving other installed copies. */
  readonly preserveUnselectedProjections?: boolean;
  readonly allowDuplicate?: boolean;
  /** Setup consent applies only to these exact symlinks, until installing succeeds. */
  readonly allowedDuplicateLinks?: readonly {
    readonly path: string;
    readonly canonicalPath: string;
    readonly dev: number;
    readonly ino: number;
    readonly linkTarget?: string;
  }[];
  readonly adoption?: InstalledSkillAdoption;
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
    targets: readonly InstallDestination[];
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

/** Accepted intent survives a later failure; callers must not mistake this for rejection. */
export class BindingChangeIncomplete
  extends Schema.TaggedError<BindingChangeIncomplete>()("Library.BindingChangeIncomplete", {
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

class BindingDestinationsIncomplete
  extends Schema.TaggedError<BindingDestinationsIncomplete>()(
    "Library.BindingDestinationsIncomplete",
    {
      paths: Schema.Array(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return `Selected destinations have not converged: ${this.paths.join(", ")}`;
  }
  readonly remediation =
    "Inspect these destinations and preserve foreign or modified content before retrying.";
}

const stale = () =>
  new SetEnabledStale({ message: "Library changed after this Binding change was previewed" });

const previewChange = Effect.fn("LibraryBindings.previewChange")(function* (
  state: LibraryState,
  options: BindingChangeRequest,
  configuration: BindingChangeConfiguration,
  targets: readonly InstallDestination[],
) {
  const { plan, skillIds, newlyEnabledSkills } = yield* calculateBindingChange(state, options);
  const { scope, bindings, changed } = plan;
  const warnings: DuplicateScanError[] = [];
  const namesToCheck = skillsToCheckForDuplicates(
    state,
    scope,
    options.enabled ? plan.skills : [],
    newlyEnabledSkills,
  );
  const shadows = namesToCheck.length
    ? yield* findDuplicates(configuration, scope, namesToCheck, warnings)
    : [];
  // Apply settles these only once it has staged SKIT's copy to compare; a preview can say they
  // are there. A link at a destination is a shadow, reported above.
  const unmanaged: Array<{ target: InstallDestination; path: string }> = [];
  if (options.enabled) {
    const fs = yield* FileSystem.FileSystem;
    for (const target of targets) {
      const root = bindingRoot(target, scope, configuration);
      for (const skillId of skillIds) {
        const skill = state.skills.find((candidate) => candidate.skill_id === skillId);
        if (skill === undefined) continue;
        const path = join(root, yield* installedSkillName(skill.name));
        if (!(yield* fs.exists(path))) continue;
        if (Option.isSome(yield* Effect.option(fs.readLink(path)))) continue;
        if ((yield* inspectOwnershipMarker(path)).kind === "valid") continue;
        unmanaged.push({ target, path });
      }
    }
  }
  // An unchanged Binding still repairs its copies when they are missing, edited, or left behind.
  let repair = false;
  if (!changed) {
    const fs = yield* FileSystem.FileSystem;
    const bound = bindings.map((binding) => new Set(bindingSkillIds(state, binding)));
    for (const target of targets) {
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
            (yield* deterministicTreeHash(projection.path)) !== projection.expected_digest;
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
    ...(unmanaged.length ? { unmanaged_destinations: unmanaged } : {}),
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
  const targets = yield* activeInstallDestinationsEffect(routing);
  let projected = current;
  const changes = [];
  for (const request of captured) {
    const change = yield* previewChange(projected, request, routing, targets);
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
    targets,
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

/** Authoritatively reload, commit Binding intent, then update installed skills to match it. */
const applyChange = Effect.fn("LibraryBindings.applyChange")(function* (
  state: LibraryState,
  options: BindingChangeRequest,
  configuration: BindingChangeConfiguration,
  repair: boolean,
  activeTargets: readonly InstallDestination[],
) {
  const currentTargets = yield* activeInstallDestinationsEffect(configuration);
  if (
    currentTargets.length !== activeTargets.length ||
    currentTargets.some((target, index) => target !== activeTargets[index])
  )
    return yield* new SetEnabledStale({
      message: "Installed agent targets changed after this Binding change was previewed",
    });
  const expectedRevision = libraryStateRevision(state);
  const store = yield* LibraryStore;
  const current = yield* store.load;
  if (libraryStateRevision(current) !== expectedRevision) return yield* stale();
  const calculated = yield* calculateBindingChange(current, options);
  const { plan, skillIds, newlyEnabledSkills } = calculated;
  const warnings: DuplicateScanError[] = [];
  const namesToCheck = skillsToCheckForDuplicates(
    current,
    plan.scope,
    options.enabled ? plan.skills : [],
    newlyEnabledSkills,
  );
  const shadows = namesToCheck.length
    ? yield* findDuplicates(configuration, plan.scope, namesToCheck, warnings)
    : [];
  if (options.enabled && !options.allowDuplicate) {
    const links = yield* LinkStat;
    const fs = yield* FileSystem.FileSystem;
    const remaining = [];
    for (const shadow of shadows) {
      const aliases = [];
      for (const alias of shadow.aliases) {
        const approved = options.allowedDuplicateLinks?.find(
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
    if (remaining.length) return yield* new InstalledSkillWouldDuplicate({ shadows: remaining });
  }
  if (options.enabled && options.allowDuplicate) {
    const destinations: string[] = [];
    for (const target of activeTargets)
      for (const skill of plan.skills)
        destinations.push(join(bindingRoot(target, plan.scope, configuration), skill));
    const links = shadows.flatMap((shadow) =>
      shadow.aliases
        .filter((alias) => isEntryLink(alias) && destinations.includes(alias.path))
        .map((alias) => alias.path),
    );
    if (links.length) return yield* new InstalledSkillWouldReplaceLink({ links });
  }
  // A root SKIT cannot write, such as `.agents` inside Codex's sandbox, fails before the Binding is
  // saved, so enabling never records intent its copies cannot follow.
  const roots = activeTargets.map((target) => bindingRoot(target, plan.scope, configuration));
  const destinations: { target: InstallDestination; path: string }[] = [];
  for (const target of activeTargets)
    for (const name of plan.skills)
      destinations.push({
        target,
        path: join(bindingRoot(target, plan.scope, configuration), yield* installedSkillName(name)),
      });
  if (options.enabled) for (const root of roots) yield* ensureSkillsDirectoryWritable(root);
  if (plan.changed) {
    let next = current;
    for (const binding of plan.bindings) next = replaceScopeBinding(next, binding);
    // Saving onto `current`, the previewed revision, makes the check above atomic.
    yield* store
      .save(next, current)
      .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(stale())));
  }
  // Only typed failures after intent acceptance become incomplete installation outcomes.
  // Defects and interruption retain their original Effect semantics.
  const reconciled = yield* Effect.result(
    Effect.gen(function* () {
      yield* updateInstalledSkills({
        roots: configuration,
        rootFor: (target) =>
          activeTargets.includes(target)
            ? bindingRoot(target, plan.scope, configuration)
            : undefined,
        variantsPath: store.variantsPath,
        onlyBindings: plan.bindings,
        restoreNativeDeletedSkills: options.enabled ? skillIds : [],
        ...(options.preserveUnselectedProjections ? { onlySkillIds: skillIds } : {}),
        ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
        adoptIdentical: options.enabled,
      });
      const settled = yield* store.load;
      if (
        libraryStateRevision(settled) !==
        libraryStateRevision((yield* lastSavedLibraryState) ?? current)
      )
        return yield* stale();
      if (options.enabled) return settled;
      // Empty Bindings are needed to retire copies; prune only after reconciliation.
      const pruned = pruneEmptyBindings(settled);
      if (pruned !== settled) yield* store.save(pruned, settled);
      return pruned;
    }),
  );
  const recorded = Result.isSuccess(reconciled)
    ? reconciled.success
    : ((yield* lastSavedLibraryState) ?? current);
  const projections = recorded.projections.flatMap(({ target, root, path, status, skill_id }) =>
    target !== "legacy" &&
    skillIds.includes(skill_id) &&
    activeTargets.includes(target) &&
    root === bindingRoot(target, plan.scope, configuration)
      ? [{ target, path, status }]
      : [],
  );
  const missing = options.enabled
    ? destinations.filter(
        (destination) =>
          !projections.some(
            (projection) =>
              projection.target === destination.target &&
              projection.path === destination.path &&
              projection.status === "installed",
          ),
      )
    : [];
  const unresolved = projections.filter(
    (projection) =>
      !options.enabled ||
      projection.status !== "installed" ||
      !destinations.some(
        (destination) =>
          destination.target === projection.target && destination.path === projection.path,
      ),
  );
  const unresolvedPaths = [
    ...new Set([...missing, ...unresolved].map((destination) => destination.path)),
  ];
  const complete = Result.isSuccess(reconciled) && unresolvedPaths.length === 0;
  const failure = Result.isFailure(reconciled)
    ? reconciled.failure
    : complete
      ? undefined
      : new BindingDestinationsIncomplete({ paths: unresolvedPaths });
  const classified = failure === undefined ? undefined : classifyFailure(failure);
  const value: SetEnabledResult = {
    ...plan,
    bindings: options.enabled
      ? plan.bindings
      : plan.bindings.filter((binding) => binding.entries.length > 0),
    ...(repair ? { repair } : {}),
    ...(shadows.length ? { shadows } : {}),
    ...(warnings.length ? { warnings } : {}),
    projections,
    application: {
      intent: plan.changed ? "saved" : "unchanged",
      revision: libraryStateRevision(recorded),
      status: complete ? "complete" : "incomplete",
      ...(classified === undefined
        ? {}
        : {
            failure: {
              code: classified.code,
              message: classified.message,
              remediation: classified.remediation,
            },
          }),
    },
  };
  if (!complete)
    return yield* new BindingChangeIncomplete({
      results: [value],
      reason: Result.isFailure(reconciled) ? "reconciliation" : "destinations",
      failure,
    });
  return { kind: "applied" as const, value };
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
      let revision = prepared.revision;
      return yield* Effect.gen(function* () {
        const outcomes: Array<{ readonly kind: "applied"; readonly value: SetEnabledResult }> = [];
        for (const [index, request] of prepared.requests.entries()) {
          const applied = yield* Effect.result(
            applyChange(
              expected,
              request,
              prepared.configuration,
              prepared.repairs[index] ?? false,
              prepared.targets,
            ),
          );
          if (Result.isFailure(applied)) {
            if (applied.failure instanceof BindingChangeIncomplete)
              return yield* new BindingChangeIncomplete({
                results: [...outcomes.map((outcome) => outcome.value), ...applied.failure.results],
                reason: applied.failure.reason,
                failure: applied.failure.failure,
              });
            if (outcomes.length)
              return yield* new BindingChangeIncomplete({
                results: outcomes.map((outcome) => outcome.value),
                reason: "request",
                failure: applied.failure,
              });
            return yield* applied.failure;
          }
          outcomes.push(applied.success);
          expected = (yield* lastSavedLibraryState) ?? expected;
        }
        return outcomes;
      }).pipe(
        Effect.provideService(LibraryStore, {
          ...store,
          save: (next, base) =>
            libraryStateRevision(base) !== revision
              ? Effect.fail(stale())
              : store.save(next, base).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      revision = libraryStateRevision(next);
                    }),
                  ),
                ),
        }),
      );
    }),
  );
});
