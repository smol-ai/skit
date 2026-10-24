import {
  canonicalJson,
  deterministicTreeHashEffect,
  inspectOwnershipMarkerEffect,
  LibraryStore,
  libraryStateRevision,
  bindingSkillIds,
  effectiveGlobalBindings,
  currentSkillVersion,
  prepareObservedCollectionEffect,
  projectBindingEffect,
  pathIsWithin,
  retainChangedProjectionEffect,
  retainedTreePath,
  versionBacking,
  withLibraryWriter,
  type LibraryState,
  type ManagedProjection,
  type Digest,
  type OwnershipMarker,
  type DeviceBinding,
  type RepositoryBinding,
  type ProjectionId,
  type SkillId,
  type SkillVersionId,
} from "@smolai/skit-core";
import { Data, Clock, Effect } from "effect";
import { join, resolve } from "node:path";
import type {
  ProjectionRetentionPlan,
  ProjectionRetentionResult,
  SkillVersionChange,
} from "./projection-retention-contract.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class ProjectionRetentionMissing
  extends Data.TaggedError("Library.ProjectionRetentionMissing")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Run `skit doctor` to inspect changed Projections.";
}

export class ProjectionRetentionAmbiguous
  extends Data.TaggedError("Library.ProjectionRetentionAmbiguous")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Use an exact Projection ID or path with `--from-projection`.";
}

export class ProjectionRetentionStale
  extends Data.TaggedError("Library.ProjectionRetentionStale")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the Projection retention again.";
}

const matchingSkill = Effect.fn("Library.ProjectionRetention.matchSkill")(function* (
  state: LibraryState,
  query: string,
) {
  const matches = state.skills.filter(
    (skill) =>
      skill.skill_id === query ||
      skill.name === query ||
      skill.versions.some((version) => version.skill_version_id === query),
  );
  if (matches.length === 0)
    return yield* new ProjectionRetentionMissing({ message: `No Skill matches ${query}` });
  if (matches.length !== 1)
    return yield* new ProjectionRetentionAmbiguous({
      message: `More than one Skill matches ${query}`,
    });
  return matches[0]!;
});

const matchingProjection = Effect.fn("Library.ProjectionRetention.matchProjection")(function* (
  projections: readonly ManagedProjection[],
  selector: string,
) {
  const matches = projections.filter(
    (projection) =>
      projection.projection_id === selector ||
      projection.target === selector ||
      resolve(projection.path) === resolve(selector),
  );
  if (matches.length === 0)
    return yield* new ProjectionRetentionMissing({
      message: `No Projection matches ${selector}`,
    });
  if (matches.length !== 1)
    return yield* new ProjectionRetentionAmbiguous({
      message: `More than one Projection matches ${selector}`,
    });
  return matches[0]!;
});

const observeProjectionRetention = Effect.fn("Library.planProjectionRetention")(function* (
  state: LibraryState,
  query: string,
  selector: string,
) {
  const skill = yield* matchingSkill(state, query);
  const previousVersion = currentSkillVersion(state, skill);
  if (previousVersion === undefined)
    return yield* new ProjectionRetentionMissing({
      message: `${skill.name} has no selected retained Version`,
    });
  const candidates = state.projections.filter(
    (projection) => projection.skill_id === skill.skill_id,
  );
  const selected = yield* matchingProjection(candidates, selector);
  const observed = yield* deterministicTreeHashEffect(selected.path);
  if (observed === selected.expected_digest)
    return yield* new ProjectionRetentionMissing({
      message: `${selected.path} has not changed from its retained Version`,
    });
  const prepared = yield* Effect.scoped(
    prepareObservedCollectionEffect([
      {
        name: skill.name,
        sourcePath: selected.path,
        relativePath: ".",
        observedHash: observed,
      },
    ]),
  );
  const observations: Array<ProjectionRetentionPlan["projections"][number]> = [];
  for (const projection of candidates) {
    const digest = yield* deterministicTreeHashEffect(projection.path);
    observations.push({
      projection_id: projection.projection_id,
      target: projection.target,
      path: projection.path,
      observed_digest: digest,
      agreement:
        projection.projection_id === selected.projection_id
          ? "selected"
          : digest === observed
            ? "identical"
            : "different",
    });
  }
  return {
    revision: libraryStateRevision(state),
    skill_id: skill.skill_id,
    skill_name: skill.name,
    previous_skill_version_id: previousVersion.skill_version_id,
    selected_projection_id: selected.projection_id,
    observed_digest: observed,
    snapshot_digest: prepared.digest,
    retained_path: retainedTreePath((yield* LibraryStore).originalsPath, prepared.digest),
    retention_required: previousVersion.artifact_digest !== observed,
    projections: observations,
  } satisfies ProjectionRetentionPlan;
});

const bindingForProjection = (
  state: LibraryState,
  projection: ManagedProjection,
): DeviceBinding | RepositoryBinding | undefined => {
  if (projection.target === "legacy") return undefined;
  const local = state.local_bindings
    .filter((binding) => pathIsWithin(binding.scope.root, projection.root))
    .sort((a, b) => b.scope.root.length - a.scope.root.length)[0];
  if (local) return bindingSkillIds(state, local).includes(projection.skill_id) ? local : undefined;
  return effectiveGlobalBindings(state).find((binding) =>
    bindingSkillIds(state, binding).includes(projection.skill_id),
  );
};

/** Reconcile every Binding destination holding a copy of this Skill. Caller owns the writer. */
const reconcileSkillCopies = Effect.fn("Library.reconcileSkillCopies")(function* (
  skillId: SkillId,
  acceptedObservations?: ReadonlyMap<
    ProjectionId,
    { readonly observedHash: Digest; readonly marker: OwnershipMarker }
  >,
) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const reconciled = new Set<string>();
  for (const projection of state.projections) {
    if (projection.skill_id !== skillId) continue;
    const binding = bindingForProjection(state, projection);
    if (binding === undefined || projection.target === "legacy") continue;
    const coordinate = `${projection.target}\0${canonicalJson(binding.scope)}\0${projection.root}`;
    if (reconciled.has(coordinate)) continue;
    reconciled.add(coordinate);
    yield* projectBindingEffect({
      target: projection.target,
      scope: binding.scope,
      root: projection.root,
      variantsPath: store.variantsPath,
      ...(acceptedObservations === undefined ? {} : { acceptedObservations }),
    });
  }
});

/**
 * Make a Version the Skill's current one and reinstall its unchanged copies. Choosing the Version
 * its Source provides follows the Source again. Caller owns the writer.
 */
const selectSkillVersion = Effect.fn("Library.selectSkillVersion")(function* (
  skillId: SkillId,
  skillVersionId: SkillVersionId,
) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const next = structuredClone(state);
  const skill = next.skills.find((item) => item.skill_id === skillId);
  if (!skill?.versions.some((version) => version.skill_version_id === skillVersionId))
    return yield* new ProjectionRetentionMissing({
      message: `${skill?.name ?? skillId} has no Version ${skillVersionId}`,
    });
  delete skill.local_version_id;
  if (currentSkillVersion(next, skill)?.skill_version_id !== skillVersionId)
    skill.local_version_id = skillVersionId;
  yield* store.publish(next, state);
  yield* reconcileSkillCopies(skillId);
});

/** Switch a Skill to one of its Library Versions; unchanged copies are reinstalled. */
export const useSkillVersion = Effect.fn("Library.useSkillVersion")(function* (
  query: string,
  versionQuery: string,
  dryRun: boolean,
) {
  const store = yield* LibraryStore;
  const skill = yield* matchingSkill(yield* store.load, query);
  const version = skill.versions.find((item) => item.skill_version_id === versionQuery);
  if (version === undefined)
    return yield* new ProjectionRetentionMissing({
      message: `${skill.name} has no Version ${versionQuery}`,
    });
  if (!dryRun)
    yield* withLibraryWriter(selectSkillVersion(skill.skill_id, version.skill_version_id));
  return {
    skill_id: skill.skill_id,
    skill_name: skill.name,
    skill_version_id: version.skill_version_id,
    applied: !dryRun,
  } satisfies SkillVersionChange;
});

/** Capture the Library and observations once; callers only render or apply this operation. */
export const prepareProjectionRetention = Effect.fn("Library.prepareProjectionRetention")(
  function* (query: string, selector: string) {
    const store = yield* LibraryStore;
    const initial = yield* store.load;
    const preview = yield* observeProjectionRetention(initial, query, selector);
    /** Refuse before taking the writer when applied against a different Library home. */
    const writing = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if ((yield* LibraryStore).home !== store.home)
          return yield* new ProjectionRetentionStale({
            message: "Projection retention belongs to a different Library",
          });
        return yield* withLibraryWriter(program);
      });
    return {
      preview: structuredClone(preview),
      apply: () => writing(retainPreviewed(preview, query, selector)),
      /** Save the edited copy as a Version, then reinstall the Version the Skill used before. */
      useLibrary: () =>
        writing(
          Effect.gen(function* () {
            const saved = yield* retainPreviewed(preview, query, selector);
            yield* selectSkillVersion(preview.skill_id, preview.previous_skill_version_id);
            return {
              skill_id: preview.skill_id,
              skill_name: preview.skill_name,
              skill_version_id: preview.previous_skill_version_id,
              saved_skill_version_id: saved.retained_skill_version_id,
              applied: true,
            } satisfies SkillVersionChange;
          }),
        ),
    };
  },
);

/** Locate the Library source and installed copy to compare; neither is changed. */
export const projectionComparisonPaths = Effect.fn("Library.projectionComparisonPaths")(function* (
  preview: ProjectionRetentionPlan,
) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const skill = state.skills.find((item) => item.skill_id === preview.skill_id);
  const projection = state.projections.find(
    (item) => item.projection_id === preview.selected_projection_id,
  );
  const version = skill && currentSkillVersion(state, skill);
  const backing = skill && version && versionBacking(state, skill, version);
  if (!projection || !backing)
    return yield* new ProjectionRetentionMissing({ message: "The selected copy is unavailable" });
  const root = retainedTreePath(store.originalsPath, backing.copy.digest);
  const libraryPath =
    backing.member.source_path === "." ? root : join(root, backing.member.source_path);
  return { libraryPath, installedPath: projection.path };
});

/** Retain the previewed copy as the Skill's Version and reconcile its copies. Caller owns the writer. */
const retainPreviewed = Effect.fn("Library.retainPreviewedProjection")(function* (
  preview: ProjectionRetentionPlan,
  query: string,
  selector: string,
) {
  const store = yield* LibraryStore;
  const current = yield* store.load;
  if (libraryStateRevision(current) !== preview.revision)
    return yield* new ProjectionRetentionStale({
      message: "Library state changed after Projection retention was previewed",
    });
  const revalidated = yield* observeProjectionRetention(current, query, selector);
  if (canonicalJson(revalidated) !== canonicalJson(preview))
    return yield* new ProjectionRetentionStale({
      message: "Projection bytes changed after Projection retention was previewed",
    });
  const selected = current.projections.find(
    (projection) => projection.projection_id === preview.selected_projection_id,
  )!;
  const retained = preview.retention_required
    ? yield* Effect.scoped(
        retainChangedProjectionEffect({
          skillId: preview.skill_id,
          projectionId: preview.selected_projection_id,
          path: selected.path,
          observedHash: preview.observed_digest,
          retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        }),
      )
    : yield* Effect.gen(function* () {
        const skill = current.skills.find((candidate) => candidate.skill_id === preview.skill_id);
        const version = skill === undefined ? undefined : currentSkillVersion(current, skill);
        const acquisition =
          skill === undefined || version === undefined
            ? undefined
            : versionBacking(current, skill, version)?.acquisition;
        if (version === undefined || acquisition === undefined)
          return yield* new ProjectionRetentionStale({
            message: "Selected retained Version is incomplete",
          });
        return {
          skillVersionId: version.skill_version_id,
          retainedCopyId: acquisition.retained_copy_id,
          snapshotDigest: preview.snapshot_digest,
        };
      });
  const accepted = new Map<
    ProjectionId,
    { readonly observedHash: Digest; readonly marker: OwnershipMarker }
  >();
  for (const projection of preview.projections) {
    if (projection.observed_digest !== preview.observed_digest) continue;
    const marker = yield* inspectOwnershipMarkerEffect(projection.path);
    if (marker.kind === "valid")
      accepted.set(projection.projection_id, {
        observedHash: projection.observed_digest,
        marker: marker.marker,
      });
  }
  yield* reconcileSkillCopies(preview.skill_id, accepted);
  const settled = yield* store.load;
  return {
    skill_id: preview.skill_id,
    skill_name: preview.skill_name,
    previous_skill_version_id: preview.previous_skill_version_id,
    retained_skill_version_id: retained.skillVersionId,
    retained_copy_id: retained.retainedCopyId,
    snapshot_digest: retained.snapshotDigest,
    retained: preview.retention_required,
    projections: preview.projections.map((observation) => {
      const projection = settled.projections.find(
        (candidate) => candidate.projection_id === observation.projection_id,
      );
      const hasBinding =
        projection === undefined ? undefined : bindingForProjection(settled, projection);
      return {
        projection_id: observation.projection_id,
        target: observation.target,
        path: observation.path,
        status:
          hasBinding === undefined
            ? ("deferred" as const)
            : projection?.status === "installed"
              ? ("projected" as const)
              : ("conflicted" as const),
      };
    }),
  } satisfies ProjectionRetentionResult;
});
