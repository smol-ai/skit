import { Effect, Schema } from "effect";
import { join } from "node:path";
import {
  LibraryManifest,
  LibraryState,
  ManagedProjection,
  ProjectionId,
  SkillId,
  LibraryStore,
  bindingSkillIds,
  currentSkillVersion,
  mergeGlobalBindings,
  projectionCustodyEffect,
  projectionNameEffect,
  projectionTargetPathIdentityEffect,
  repositorySelectsProjection,
  withProjectionMutationEffect,
  type ProjectionTarget,
  type BindingEntry,
} from "@smolai/skit-core";
import { SyncConflictDetail } from "./library-sync-contract.js";
import { existingRepositoryProjectionRoot } from "../../projection/roots.js";

const targets = ["agents", "claude"] as const;
const Candidate = Schema.Struct({
  path: Schema.String,
  skill_id: SkillId,
  target: Schema.Literals(targets),
  global: Schema.Boolean,
});

/** Compare destinations using filesystem evidence, including symlink and case aliases. */
export const resolveSyncProjectionCollisionsEffect = Effect.fn("Library.sync.projectionCollisions")(
  function* (
    manifest: LibraryManifest,
    rootFor: ((target: ProjectionTarget) => string | undefined) | undefined,
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
        const path = join(root, yield* projectionNameEffect(skill.name));
        const identity = yield* projectionTargetPathIdentityEffect(path);
        const group = groups.get(identity.comparisonKey) ?? [];
        group.push({ path, skill_id: skill.skill_id, target, global: true });
        groups.set(identity.comparisonKey, group);
      }
    }
    if (device !== undefined) {
      for (const binding of device.local_bindings) {
        for (const target of targets) {
          const root = existingRepositoryProjectionRoot(device, binding, target);
          if (root === undefined) continue;
          const ids = new Set(bindingSkillIds(manifest, binding));
          for (const skill of manifest.skills.filter((item) => ids.has(item.skill_id))) {
            const path = join(root, yield* projectionNameEffect(skill.name));
            const identity = yield* projectionTargetPathIdentityEffect(path);
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
            items
              .filter((item) => keepEnabled.includes(item.skill_id))
              .map((item) => item.skill_id),
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
  },
);

const SyncProjectionPlan = Schema.Struct({
  projections: Schema.Array(ManagedProjection),
  retire: Schema.Array(ProjectionId),
  remove: Schema.Array(ProjectionId),
  conflicts: Schema.Array(SyncConflictDetail),
});
export type SyncProjectionPlan = typeof SyncProjectionPlan.Type;

/** Preview every affected copy, including repository custody, before any remote write. */
export const planSyncProjectionsEffect = Effect.fn("Library.sync.planProjections")(function* (
  current: LibraryState,
  aligned: LibraryState,
  manifest: LibraryManifest,
  rootFor: ((target: ProjectionTarget) => string | undefined) | undefined,
) {
  const projections: ManagedProjection[] = [];
  const retire: ProjectionId[] = [];
  const remove: ProjectionId[] = [];
  const conflicts: SyncConflictDetail[] = [];
  const enabledIds = new Set(
    [...manifest.bindings, ...aligned.local_bindings].flatMap((binding) =>
      bindingSkillIds(manifest, binding),
    ),
  );
  for (const skill of manifest.skills) {
    if (!enabledIds.has(skill.skill_id) || currentSkillVersion(manifest, skill) !== undefined)
      continue;
    conflicts.push(
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
    const repository = repositorySelectsProjection(aligned, projection);
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
      (yield* projectionTargetPathIdentityEffect(root)).comparisonKey !==
        (yield* projectionTargetPathIdentityEffect(projection.root)).comparisonKey;
    const changing =
      removing ||
      reidentifying ||
      missingVersion ||
      relocating ||
      (selected !== undefined && selected.skill_version_id !== projection.skill_version_id);
    if (changing) {
      const custody = yield* projectionCustodyEffect(original);
      if (custody.kind === "conflicted") {
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
  return yield* SyncProjectionPlan.makeEffect({ projections, retire, remove, conflicts });
});

/** Keep old references durable until portable state and ancestry can be published together. */
export const retireSyncProjectionsEffect = Effect.fn("Library.sync.retireProjections")(function* (
  plan: SyncProjectionPlan,
  variantsPath: string,
) {
  const store = yield* LibraryStore;
  if (plan.retire.length === 0) return 0;
  const current = yield* store.load;
  const pending = {
    ...current,
    projections: current.projections.map((projection) =>
      plan.retire.includes(projection.projection_id) &&
      !plan.remove.includes(projection.projection_id) &&
      projection.suppression_reason !== "native_delete"
        ? { ...projection, status: "pending" as const }
        : projection,
    ),
  };
  // Persist the intent before removing an aliased copy, so an intervening inventory scan cannot
  // mistake an interrupted managed relocation for a user's native deletion.
  yield* store.publish(pending);
  const result = yield* withProjectionMutationEffect(
    pending,
    { rootFor: () => undefined, variantsPath, publish: store.publish },
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
          else if (outcome.kind === "retired") projection.status = "pending";
        }
        return retired;
      }),
  );
  return result.value;
});
