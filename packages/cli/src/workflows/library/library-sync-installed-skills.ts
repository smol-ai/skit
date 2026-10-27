import { Effect, Schema } from "effect";
import { join } from "node:path";
import {
  LibraryManifest,
  LibraryState,
  InstalledSkill,
  InstalledSkillId,
  SkillId,
  LibraryStore,
  LibraryChanged,
  blendRestoredStateEffect,
  withLibraryWriter,
  bindingSkillIds,
  currentSkillVersion,
  mergeGlobalBindings,
  installedSkillCustodyEffect,
  installedSkillNameEffect,
  installDestinationPathIdentityEffect,
  repositorySelectsInstalledSkill,
  withInstalledSkillMutationEffect,
  type InstallDestination,
  type BindingEntry,
} from "@smolai/skit-core";
import { SyncConflictDetail } from "./library-sync-contract.js";
import { existingRepositorySkillsDirectory } from "../../projection/roots.js";

const targets = ["agents", "claude"] as const;
const Candidate = Schema.Struct({
  path: Schema.String,
  skill_id: SkillId,
  target: Schema.Literals(targets),
  global: Schema.Boolean,
});

/** Compare destinations using filesystem evidence, including symlink and case aliases. */
export const resolveSyncInstalledSkillCollisionsEffect = Effect.fn(
  "Library.sync.installedSkillCollisions",
)(function* (
  manifest: LibraryManifest,
  rootFor: ((target: InstallDestination) => string | undefined) | undefined,
  keepEnabled: readonly string[] = [],
  device?: LibraryState,
) {
  const groups = new Map<string, (typeof Candidate.Type)[]>();
  const enabled = new Set(
    manifest.bindings.flatMap((binding) => bindingSkillIds(manifest, binding)),
  );
  for (const target of targets) {
    const root = rootFor?.(target);
    if (root === undefined) continue;
    for (const skill of manifest.skills.filter((item) => enabled.has(item.skill_id))) {
      const path = join(root, yield* installedSkillNameEffect(skill.name));
      const identity = yield* installDestinationPathIdentityEffect(path);
      const group = groups.get(identity.comparisonKey) ?? [];
      group.push({ path, skill_id: skill.skill_id, target, global: true });
      groups.set(identity.comparisonKey, group);
    }
  }
  if (device !== undefined) {
    for (const binding of device.local_bindings) {
      for (const target of targets) {
        const root = existingRepositorySkillsDirectory(device, binding, target);
        if (root === undefined) continue;
        const ids = new Set(bindingSkillIds(manifest, binding));
        for (const skill of manifest.skills.filter((item) => ids.has(item.skill_id))) {
          const path = join(root, yield* installedSkillNameEffect(skill.name));
          const identity = yield* installDestinationPathIdentityEffect(path);
          const group = groups.get(identity.comparisonKey) ?? [];
          group.push({ path, skill_id: skill.skill_id, target, global: false });
          groups.set(identity.comparisonKey, group);
        }
      }
    }
  }
  const collisions = [...groups.values()].filter(
    (items) => new Set(items.map((item) => `${item.target}:${item.skill_id}`)).size > 1,
  );
  const canChoose = (items: readonly (typeof Candidate.Type)[]) =>
    items.every((item) => item.global) && new Set(items.map((item) => item.target)).size === 1;
  const candidates = new Set(
    collisions.filter(canChoose).flatMap((items) => items.map((item) => item.skill_id)),
  );
  const invalid =
    keepEnabled.some((id) => ![...candidates].some((candidate) => candidate === id)) ||
    collisions.some(
      (items) =>
        new Set(
          items.filter((item) => keepEnabled.includes(item.skill_id)).map((item) => item.skill_id),
        ).size > 1,
    );
  const disabled = new Set<string>();
  const conflicts: SyncConflictDetail[] = [];
  for (const items of collisions) {
    const selected = items.find((item) => keepEnabled.includes(item.skill_id));
    if (selected !== undefined && canChoose(items)) {
      for (const item of items)
        if (item.skill_id !== selected.skill_id) disabled.add(item.skill_id);
      continue;
    }
    const labels = [...new Set(items.map((item) => item.skill_id))].map((id) => {
      const skill = manifest.skills.find((item) => item.skill_id === id);
      const collection = manifest.collections.find(
        (item) => item.collection_id === skill?.collection_id,
      );
      return `${skill?.name ?? id} from ${collection?.label ?? id} (${id})`;
    });
    conflicts.push(
      SyncConflictDetail.make({
        key: `projection:${items.map((item) => item.path).sort()[0]}:collision`,
        message: `${labels.join("; ")} use the same destination. ${canChoose(items) ? "Keep one enabled Library-wide with skit sync --apply --keep-enabled <skill-id>. Both remain retained." : "Configure distinct projection roots or disable the competing repository selection before syncing."}`,
        resolution: canChoose(items) ? "keep-enabled" : "local",
      }),
    );
  }
  const bindings =
    disabled.size === 0
      ? manifest.bindings
      : mergeGlobalBindings(manifest, [
          {
            entries: manifest.bindings.flatMap((binding) =>
              binding.entries.flatMap((entry): BindingEntry[] => {
                const ids = bindingSkillIds(manifest, { entries: [entry] });
                if (!ids.some((id) => disabled.has(id))) return [entry];
                return ids
                  .filter((id) => !disabled.has(id))
                  .map((skill_id) => ({ kind: "skill", skill_id }));
              }),
            ),
          },
        ]);
  return {
    manifest: yield* LibraryManifest.makeEffect({ ...manifest, bindings }),
    conflicts,
    invalid,
  };
});

const SyncInstalledSkillPlan = Schema.Struct({
  projections: Schema.Array(InstalledSkill),
  retire: Schema.Array(InstalledSkillId),
  remove: Schema.Array(InstalledSkillId),
  conflicts: Schema.Array(SyncConflictDetail),
  issues: Schema.Array(SyncConflictDetail),
});
type SyncInstalledSkillPlan = typeof SyncInstalledSkillPlan.Type;

/** Preview every affected copy, including repository custody, before any remote write. */
const planSyncInstalledSkillsEffect = Effect.fn("Library.sync.planInstalledSkills")(function* (
  current: LibraryState,
  aligned: LibraryState,
  manifest: LibraryManifest,
  rootFor: ((target: InstallDestination) => string | undefined) | undefined,
  deferDeviceConflicts: boolean,
) {
  const projections: InstalledSkill[] = [];
  const retire: InstalledSkillId[] = [];
  const remove: InstalledSkillId[] = [];
  const conflicts: SyncConflictDetail[] = [];
  const issues: SyncConflictDetail[] = [];
  const enabledIds = new Set(
    [...manifest.bindings, ...aligned.local_bindings].flatMap((binding) =>
      bindingSkillIds(manifest, binding),
    ),
  );
  for (const skill of manifest.skills) {
    if (!enabledIds.has(skill.skill_id) || currentSkillVersion(manifest, skill) !== undefined)
      continue;
    const repositorySelected = aligned.local_bindings.some((binding) =>
      bindingSkillIds(manifest, binding).includes(skill.skill_id),
    );
    (deferDeviceConflicts && !repositorySelected ? issues : conflicts).push(
      SyncConflictDetail.make({
        key: `skill:${skill.skill_id}:no-selected-version`,
        message: `${skill.name} has no selected retained Version. Update it or disable its Binding before syncing.`,
        resolution: "local",
      }),
    );
  }
  for (const binding of aligned.local_bindings) {
    if (
      binding.entries.every((entry) =>
        entry.kind === "skill"
          ? manifest.skills.some((skill) => skill.skill_id === entry.skill_id)
          : manifest.collections.some(
              (collection) => collection.collection_id === entry.collection_id,
            ),
      )
    )
      continue;
    conflicts.push(
      SyncConflictDetail.make({
        key: `device:${binding.scope.root}:repository-binding`,
        message: `The repository Binding at ${binding.scope.root} still selects a removed entity. Disable that repository selection before syncing.`,
        resolution: "local",
      }),
    );
  }
  for (const original of current.projections) {
    const projection = aligned.projections.find(
      (item) => item.projection_id === original.projection_id,
    );
    if (projection === undefined) continue;
    const skill = manifest.skills.find((item) => item.skill_id === projection.skill_id);
    const selected = skill === undefined ? undefined : currentSkillVersion(manifest, skill);
    const global = manifest.bindings.some((binding) =>
      bindingSkillIds(manifest, binding).includes(projection.skill_id),
    );
    const repository = repositorySelectsInstalledSkill(aligned, projection);
    const activeTarget = targets.find((target) => target === projection.target);
    const active =
      activeTarget !== undefined && (rootFor === undefined || rootFor(activeTarget) !== undefined);
    const removing = !active || (!global && !repository);
    const reidentifying = original.skill_id !== projection.skill_id;
    const missingVersion = !skill?.versions.some(
      (version) => version.skill_version_id === projection.skill_version_id,
    );
    const root =
      global && !repository && activeTarget !== undefined ? rootFor?.(activeTarget) : undefined;
    const relocating =
      root !== undefined &&
      (yield* installDestinationPathIdentityEffect(root)).comparisonKey !==
        (yield* installDestinationPathIdentityEffect(projection.root)).comparisonKey;
    const changing =
      removing ||
      reidentifying ||
      missingVersion ||
      relocating ||
      (selected !== undefined && selected.skill_version_id !== projection.skill_version_id);
    if (changing) {
      const custody = yield* installedSkillCustodyEffect(original);
      if (custody.kind === "conflicted") {
        if (
          deferDeviceConflicts &&
          removing &&
          !reidentifying &&
          !relocating &&
          skill !== undefined &&
          !missingVersion
        ) {
          issues.push(
            SyncConflictDetail.make({
              key: `device:${original.projection_id}:modified-projection`,
              message: `Cannot retire modified Skill at ${original.path}. Save the edited directory outside the projection root, then restore the managed copy before retrying.`,
              resolution: "local",
            }),
          );
          projections.push({
            ...projection,
            status: "conflicted",
            observed_digest: custody.observed,
          });
          continue;
        }
        // Normal updates preserve edited bytes as variants. Inactive routes are reported by
        // reconciliation while their references remain valid; neither requires strict retirement.
        if (
          !reidentifying &&
          !relocating &&
          !(removing && active) &&
          skill !== undefined &&
          (!removing || !missingVersion) &&
          (!missingVersion || selected !== undefined)
        ) {
          projections.push({
            ...projection,
            ...(missingVersion && selected !== undefined
              ? { skill_version_id: selected.skill_version_id }
              : {}),
            status: "conflicted",
            observed_digest: custody.observed,
          });
          continue;
        }
        conflicts.push(
          SyncConflictDetail.make({
            key: `device:${original.projection_id}:modified-projection`,
            message: `Sync would replace or remove ${original.path}, whose bytes or ownership changed. Save the edited directory outside the projection root, then restore the managed copy before syncing.`,
            resolution: "local",
          }),
        );
        projections.push(projection);
        continue;
      }
    }
    if (removing) {
      remove.push(original.projection_id);
      retire.push(original.projection_id);
      continue;
    }
    if (missingVersion && selected === undefined) {
      conflicts.push(
        SyncConflictDetail.make({
          key: `device:${original.projection_id}:managed-projection`,
          message: `No retained Version can replace ${original.path}.`,
          resolution: "local",
        }),
      );
      projections.push(projection);
      continue;
    }
    if (reidentifying) retire.push(original.projection_id);
    projections.push({
      ...projection,
      ...(reidentifying && projection.suppression_reason !== "native_delete"
        ? { status: "pending" as const }
        : {}),
      ...(missingVersion && selected !== undefined
        ? { skill_version_id: selected.skill_version_id }
        : {}),
    });
  }
  return yield* SyncInstalledSkillPlan.makeEffect({
    projections,
    retire,
    remove,
    conflicts,
    issues,
  });
});

/**
 * Keep old references durable until portable state and ancestry can be saved together.
 * Saves only onto `current`, the state sync planned from, and returns the state it saved.
 */
const retireSyncInstalledSkillsEffect = Effect.fn("Library.sync.retireInstalledSkills")(function* (
  plan: SyncInstalledSkillPlan,
  current: LibraryState,
) {
  const store = yield* LibraryStore;
  if (plan.retire.length === 0) return { retired: 0, state: current };
  const result = yield* withInstalledSkillMutationEffect(
    current,
    {
      rootFor: () => undefined,
      variantsPath: store.variantsPath,
      originalsPath: store.originalsPath,
      save: store.save,
    },
    (mutation) =>
      Effect.gen(function* () {
        let retired = 0;
        for (const id of plan.retire) {
          const projection = mutation.state.projections.find((item) => item.projection_id === id);
          if (projection === undefined) continue;
          const outcome = yield* mutation.retire(
            projection,
            "throw",
            `Refusing to remove modified Skill at ${projection.path}`,
          );
          if (outcome.kind === "retired") retired++;
          if (plan.remove.includes(id))
            mutation.state.projections.splice(
              0,
              mutation.state.projections.length,
              ...mutation.state.projections.filter((item) => item.projection_id !== id),
            );
          else if (projection.suppression_reason !== "native_delete") projection.status = "pending";
        }
        return retired;
      }),
  );
  return { retired: result.value, state: result.state };
});

/** Prepare this device's local transition before remote publication; keep mutation records private. */
export const prepareSyncDeviceTransition = Effect.fn("Library.sync.prepareDeviceTransition")(
  function* (options: {
    readonly current: LibraryState | undefined;
    readonly aligned: LibraryState;
    readonly baseline?: LibraryState;
    readonly manifest: LibraryManifest;
    readonly rootFor: ((target: InstallDestination) => string | undefined) | undefined;
    readonly deferDeviceConflicts?: boolean;
  }) {
    const store = yield* LibraryStore;
    const home = store.home;
    const { current, aligned } = options;
    // An absent Library has no local copies to protect. A pull may accept remote Bindings
    // without a selected Version, which planning an empty device would otherwise reject.
    const plan =
      current === undefined
        ? undefined
        : yield* planSyncInstalledSkillsEffect(
            current,
            aligned,
            options.manifest,
            options.rootFor,
            options.deferDeviceConflicts ?? false,
          );
    if (plan?.conflicts.length) return { _tag: "Conflicted" as const, conflicts: plan.conflicts };
    const baseline = current ?? options.baseline ?? aligned;
    return {
      _tag: "Ready" as const,
      issues: plan?.issues ?? [],
      saveRestored: Effect.fn("Library.sync.saveDeviceTransition")(function* (
        restored: LibraryState,
        ancestry: NonNullable<LibraryState["sync_ancestry"]>,
      ) {
        const store = yield* LibraryStore;
        if (store.home !== home) return yield* new LibraryChanged({ path: store.statePath });
        return yield* withLibraryWriter(
          Effect.gen(function* () {
            const retirement =
              plan === undefined
                ? { retired: 0, state: baseline }
                : yield* retireSyncInstalledSkillsEffect(plan, baseline);
            const blended = yield* blendRestoredStateEffect(
              { ...aligned, projections: [...(plan?.projections ?? [])] },
              restored,
            );
            // Save content and its accepted base together, replacing exactly the state retirement
            // saved (or the original baseline when no retirement was required).
            yield* store.save({ ...blended, sync_ancestry: ancestry }, retirement.state);
            return retirement.retired;
          }),
        );
      }),
    };
  },
);
