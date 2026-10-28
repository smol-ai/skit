import { join } from "node:path";
import {
  enabledSkillIds,
  skillsToCheckForDuplicates,
  LinkStat,
  deterministicTreeHash,
  ensureSkillsDirectoryWritable,
  inspectOwnershipMarker,
  installedSkillName,
  type InstallDestination,
  setEnabledAt,
  pruneEmptyEnabled,
  lastSavedLibraryState,
  LibraryStore,
  libraryStateRevision,
  withLibraryWriter,
  FailureTypeId,
  type SkitFailure,
  type LibraryState,
} from "@smolai/skit-core";
import { Data, Effect, FileSystem, Option, Result, Schema } from "effect";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "../install/roots.js";
import {
  isEntryLink,
  findDuplicates,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  type DuplicateScanError,
} from "../install/duplicates.js";
import { updateInstalledSkills } from "../workflows/library/update-installed-skills.js";
import {
  calculateSetEnabled,
  expandSetEnabledIntent,
  type SetEnabledIntent,
  type SetEnabledRequest,
} from "../workflows/library/set-enabled-request.js";
import { libraryView } from "./library-view.js";
export type {
  SetEnabledIntent,
  SetEnabledRequest,
  EnabledCollection,
} from "../workflows/library/set-enabled-request.js";
import { classifyFailure } from "../failure-classification.js";
import { SetEnabledResult } from "../workflows/library/set-enabled-contract.js";

export type SetEnabledConfiguration = InventoryRootOptions;

const planType = Symbol("SetEnabledPlan");
/** Display facts plus an opaque handle to the exact requests and Library previewed. */
export interface SetEnabledPlan {
  readonly [planType]: true;
  readonly changes: readonly Effect.Success<ReturnType<typeof planChange>>[];
}

const preparedPlans = new WeakMap<
  SetEnabledPlan,
  {
    home: string;
    revision: string;
    requests: readonly SetEnabledRequest[];
    configuration: SetEnabledConfiguration;
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

class SetEnabledDestinationsIncomplete
  extends Schema.TaggedError<SetEnabledDestinationsIncomplete>()(
    "Library.SetEnabledDestinationsIncomplete",
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

const planChange = Effect.fn("SetEnabled.planChange")(function* (
  state: LibraryState,
  options: SetEnabledRequest,
  configuration: SetEnabledConfiguration,
  targets: readonly InstallDestination[],
) {
  const { plan, skillIds, newlyEnabledSkills, hasList } = yield* calculateSetEnabled(
    state,
    options,
  );
  const { scope, changed } = plan;
  const warnings: DuplicateScanError[] = [];
  const namesToCheck = skillsToCheckForDuplicates(
    state,
    scope,
    options.enabled ? plan.skills : [],
    newlyEnabledSkills,
  );
  const duplicates = namesToCheck.length
    ? yield* findDuplicates(configuration, scope, namesToCheck, warnings)
    : [];
  // Apply settles these only once it has staged SKIT's copy to compare; a preview can say they
  // are there. A link at a destination is a duplicate, reported above.
  const unmanaged: Array<{ destination: InstallDestination; path: string }> = [];
  if (options.enabled) {
    const fs = yield* FileSystem.FileSystem;
    for (const target of targets) {
      const root = skillsDirectoryFor(target, scope, configuration);
      for (const skillId of skillIds) {
        const skill = state.skills.find((candidate) => candidate.skill_id === skillId);
        if (skill === undefined) continue;
        const path = join(root, yield* installedSkillName(skill.name));
        if (!(yield* fs.exists(path))) continue;
        if (Option.isSome(yield* Effect.option(fs.readLink(path)))) continue;
        if ((yield* inspectOwnershipMarker(path)).kind === "valid") continue;
        unmanaged.push({ destination: target, path });
      }
    }
  }
  // An unchanged scope still repairs its copies when they are missing, edited, or left behind.
  let repair = false;
  if (!changed) {
    const fs = yield* FileSystem.FileSystem;
    const bound = new Set(enabledSkillIds(state, plan.enabled));
    for (const target of targets) {
      const root = skillsDirectoryFor(target, scope, configuration);
      const installedSkills = state.installed_skills.filter(
        (installedSkill) => installedSkill.root === root && installedSkill.destination === target,
      );
      if (options.enabled)
        for (const skillId of skillIds) {
          const installedSkill = installedSkills.find(
            (candidate) => candidate.skill_id === skillId,
          );
          repair ||=
            installedSkill === undefined ||
            installedSkill.status !== "installed" ||
            !(yield* fs.exists(installedSkill.path)) ||
            (yield* deterministicTreeHash(installedSkill.path)) !== installedSkill.expected_digest;
        }
      else if (hasList)
        for (const installedSkill of installedSkills)
          if (!bound.has(installedSkill.skill_id)) repair ||= yield* fs.exists(installedSkill.path);
    }
  }
  return {
    ...plan,
    ...(duplicates.length ? { duplicates } : {}),
    ...(unmanaged.length ? { unmanaged_destinations: unmanaged } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(repair ? { repair } : {}),
  };
});

/** The raw request path is retained for internal managing workflows. */
const planRequests = Effect.fn("SetEnabled.planRequests")(function* (
  current: LibraryState,
  home: string,
  requests: readonly SetEnabledRequest[],
  configuration: SetEnabledConfiguration,
) {
  const routing = {
    home: configuration.home,
    configHome: configuration.configHome,
    overrides: structuredClone(configuration.overrides),
  };
  const captured = structuredClone(requests);
  const targets = yield* activeInstallDestinations(routing);
  let installed = current;
  const changes = [];
  for (const request of captured) {
    const change = yield* planChange(installed, request, routing, targets);
    changes.push(change);
    // Later plans see earlier intent at the same scope, just as apply does.
    if (change.changed) installed = setEnabledAt(installed, change.scope, change);
  }
  const plan: SetEnabledPlan = { [planType]: true, changes: structuredClone(changes) };
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
export function setEnabledSession(current: LibraryState, home: string, originalsPath: string) {
  return {
    view: libraryView(current, originalsPath),
    planMany: Effect.fn("SetEnabled.planIntents")(function* (
      intents: readonly SetEnabledIntent[],
      configuration: SetEnabledConfiguration,
    ) {
      const requests = yield* Effect.forEach(intents, (intent) =>
        expandSetEnabledIntent(current, intent),
      );
      return yield* planRequests(current, home, requests.flat(), configuration);
    }),
    plan: Effect.fn("SetEnabled.planIntent")(function* (
      intent: SetEnabledIntent,
      configuration: SetEnabledConfiguration,
    ) {
      const requests = yield* expandSetEnabledIntent(current, intent);
      return yield* planRequests(current, home, requests, configuration);
    }),
  };
}

/** Read facts and accept intents against the Library displayed before asking questions. */
export const openSetEnabledSession = Effect.fn("SetEnabled.openSession")(function* () {
  const store = yield* LibraryStore;
  return setEnabledSession(yield* store.load, store.home, store.originalsPath);
});
export type SetEnabledSession = Effect.Success<ReturnType<typeof openSetEnabledSession>>;

/** Internal managing/testing entry point; front ends use a held selection and user intent. */
export const planSetEnabled = Effect.fn("SetEnabled.plan")(function* (
  requests: readonly SetEnabledRequest[],
  configuration: SetEnabledConfiguration,
) {
  const store = yield* LibraryStore;
  return yield* planRequests(yield* store.load, store.home, requests, configuration);
});

/** Authoritatively reload, save what is enabled, then update installed skills to match it. */
const applyChange = Effect.fn("SetEnabled.applyChange")(function* (
  state: LibraryState,
  options: SetEnabledRequest,
  configuration: SetEnabledConfiguration,
  repair: boolean,
  activeTargets: readonly InstallDestination[],
) {
  const currentTargets = yield* activeInstallDestinations(configuration);
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
  const calculated = yield* calculateSetEnabled(current, options);
  const { plan, skillIds, newlyEnabledSkills, hasList } = calculated;
  const warnings: DuplicateScanError[] = [];
  const namesToCheck = skillsToCheckForDuplicates(
    current,
    plan.scope,
    options.enabled ? plan.skills : [],
    newlyEnabledSkills,
  );
  const duplicates = namesToCheck.length
    ? yield* findDuplicates(configuration, plan.scope, namesToCheck, warnings)
    : [];
  if (options.enabled && !options.allowDuplicate) {
    const links = yield* LinkStat;
    const fs = yield* FileSystem.FileSystem;
    const remaining = [];
    for (const duplicate of duplicates) {
      const aliases = [];
      for (const alias of duplicate.aliases) {
        const approved = options.allowedDuplicateSymlinks?.find(
          (item) => item.path === alias.path && item.canonicalPath === duplicate.canonicalPath,
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
      if (aliases.length) remaining.push({ ...duplicate, aliases });
    }
    if (remaining.length) return yield* new InstalledSkillWouldDuplicate({ duplicates: remaining });
  }
  if (options.enabled && options.allowDuplicate) {
    const destinations: string[] = [];
    for (const target of activeTargets)
      for (const skill of plan.skills)
        destinations.push(join(skillsDirectoryFor(target, plan.scope, configuration), skill));
    const links = duplicates.flatMap((duplicate) =>
      duplicate.aliases
        .filter((alias) => isEntryLink(alias) && destinations.includes(alias.path))
        .map((alias) => alias.path),
    );
    if (links.length) return yield* new InstalledSkillWouldReplaceLink({ links });
  }
  // A root SKIT cannot write, such as `.agents` inside Codex's sandbox, fails before the Binding is
  // saved, so enabling never records intent its copies cannot follow.
  const roots = activeTargets.map((target) =>
    skillsDirectoryFor(target, plan.scope, configuration),
  );
  const destinations: { destination: InstallDestination; path: string }[] = [];
  for (const target of activeTargets)
    for (const name of plan.skills)
      destinations.push({
        destination: target,
        path: join(
          skillsDirectoryFor(target, plan.scope, configuration),
          yield* installedSkillName(name),
        ),
      });
  if (options.enabled) for (const root of roots) yield* ensureSkillsDirectoryWritable(root);
  if (plan.changed) {
    const next = setEnabledAt(current, plan.scope, plan);
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
            ? skillsDirectoryFor(target, plan.scope, configuration)
            : undefined,
        variantsPath: store.variantsPath,
        onlyScopes: hasList ? [plan] : [],
        restoreNativeDeletedSkills: options.enabled ? skillIds : [],
        ...(options.keepUnselectedInstalledSkills ? { onlySkillIds: skillIds } : {}),
        ...(options.manage === undefined ? {} : { manage: options.manage }),
        manageIdentical: options.enabled,
      });
      const settled = yield* store.load;
      if (
        libraryStateRevision(settled) !==
        libraryStateRevision((yield* lastSavedLibraryState) ?? current)
      )
        return yield* stale();
      if (options.enabled) return settled;
      // An empty list is needed to uninstall copies; prune only once they are updated.
      const pruned = pruneEmptyEnabled(settled);
      if (pruned !== settled) yield* store.save(pruned, settled);
      return pruned;
    }),
  );
  const recorded = Result.isSuccess(reconciled)
    ? reconciled.success
    : ((yield* lastSavedLibraryState) ?? current);
  const installedSkills = recorded.installed_skills.flatMap(
    ({ destination, root, path, status, skill_id }) =>
      destination !== "legacy" &&
      skillIds.includes(skill_id) &&
      activeTargets.includes(destination) &&
      root === skillsDirectoryFor(destination, plan.scope, configuration)
        ? [{ destination, path, status }]
        : [],
  );
  const missing = options.enabled
    ? destinations.filter(
        (destination) =>
          !installedSkills.some(
            (installedSkill) =>
              installedSkill.destination === destination.destination &&
              installedSkill.path === destination.path &&
              installedSkill.status === "installed",
          ),
      )
    : [];
  const unresolved = installedSkills.filter(
    (installedSkill) =>
      !options.enabled ||
      installedSkill.status !== "installed" ||
      !destinations.some(
        (destination) =>
          destination.destination === installedSkill.destination &&
          destination.path === installedSkill.path,
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
      : new SetEnabledDestinationsIncomplete({ paths: unresolvedPaths });
  const classified = failure === undefined ? undefined : classifyFailure(failure);
  const value: SetEnabledResult = {
    ...plan,
    ...(repair ? { repair } : {}),
    ...(duplicates.length ? { duplicates: duplicates } : {}),
    ...(warnings.length ? { warnings } : {}),
    installed_skills: installedSkills,
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
    return yield* new SetEnabledIncomplete({
      results: [value],
      reason: Result.isFailure(reconciled) ? "reconciliation" : "destinations",
      failure,
    });
  return { kind: "applied" as const, value };
});

/** Revalidate and apply the prepared requests in order under one recording writer. */
export const applySetEnabledPlan = Effect.fn("SetEnabled.applyPlan")(function* (
  plan: SetEnabledPlan,
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
            if (applied.failure instanceof SetEnabledIncomplete)
              return yield* new SetEnabledIncomplete({
                results: [...outcomes.map((outcome) => outcome.value), ...applied.failure.results],
                reason: applied.failure.reason,
                failure: applied.failure.failure,
              });
            if (outcomes.length)
              return yield* new SetEnabledIncomplete({
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
