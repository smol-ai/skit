import {
  canonicalJson,
  deterministicTreeHashEffect,
  inspectOwnershipMarkerEffect,
  LibraryStore,
  prepareObservedCollectionEffect,
  projectBindingEffect,
  retainChangedProjectionEffect,
  retainedTreePath,
  withLibraryWriter,
  type LibraryState,
  type ManagedProjection,
  type Digest,
  type OwnershipMarker,
  type DeviceBinding,
  type RepositoryBinding,
  type ProjectionId,
} from "@smolai/skit-core";
import { Clock, Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { InventoryRootOptions } from "../../projection/roots.js";
import type {
  ProjectionRetentionPlan,
  ProjectionRetentionResult,
} from "./projection-retention-contract.js";

export class ProjectionRetentionMissing extends Schema.TaggedError<ProjectionRetentionMissing>()(
  "Library.ProjectionRetentionMissing",
  { message: Schema.String },
) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit doctor` to inspect changed Projections.";
}

export class ProjectionRetentionAmbiguous extends Schema.TaggedError<ProjectionRetentionAmbiguous>()(
  "Library.ProjectionRetentionAmbiguous",
  { message: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use an exact Projection ID or path with `--from-projection`.";
}

export class ProjectionRetentionStale extends Schema.TaggedError<ProjectionRetentionStale>()(
  "Library.ProjectionRetentionStale",
  { message: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Preview the Projection retention again.";
}

interface ProjectionRetentionOptions {
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
}

const revision = (state: LibraryState) =>
  createHash("sha256").update(canonicalJson(state)).digest("hex");

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
      projection.harness === selector ||
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

export const planProjectionRetention = Effect.fn("Library.planProjectionRetention")(function* (
  state: LibraryState,
  options: ProjectionRetentionOptions,
  query: string,
  selector: string,
) {
  const skill = yield* matchingSkill(state, query);
  const previousVersion = skill.versions.find(
    (version) => version.skill_version_id === skill.selected_skill_version_id,
  );
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
      harness: projection.harness,
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
    revision: revision(state),
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
): DeviceBinding | RepositoryBinding | undefined =>
  [...state.global_bindings, ...state.local_bindings].find(
    (binding) =>
      binding.harness === projection.harness &&
      binding.skills.includes(projection.skill_id) &&
      (binding.scope.kind === "global" || resolve(binding.scope.root) === resolve(projection.root)),
  );

export const applyProjectionRetention = Effect.fn("Library.applyProjectionRetention")(function* (
  initial: LibraryState,
  options: ProjectionRetentionOptions,
  query: string,
  selector: string,
) {
  const preview = yield* planProjectionRetention(initial, options, query, selector);
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const store = yield* LibraryStore;
      const current = yield* store.load;
      if (revision(current) !== preview.revision)
        return yield* new ProjectionRetentionStale({
          message: "Library state changed after Projection retention was previewed",
        });
      const revalidated = yield* planProjectionRetention(current, options, query, selector);
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
            const skill = current.skills.find(
              (candidate) => candidate.skill_id === preview.skill_id,
            );
            const version = skill?.versions.find(
              (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
            );
            const origin = version?.origins[0];
            const acquisition = current.acquisitions.find(
              (candidate) => candidate.acquisition_id === origin?.acquisition_id,
            );
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
      const afterRetention = yield* store.load;
      const reconciled = new Set<string>();
      for (const observation of preview.projections) {
        const projection = afterRetention.projections.find(
          (candidate) => candidate.projection_id === observation.projection_id,
        );
        const binding =
          projection === undefined ? undefined : bindingForProjection(afterRetention, projection);
        if (projection === undefined || binding === undefined) continue;
        const coordinate = `${binding.harness}\0${canonicalJson(binding.scope)}\0${projection.root}`;
        if (reconciled.has(coordinate)) continue;
        reconciled.add(coordinate);
        yield* projectBindingEffect({
          harness: binding.harness,
          scope: binding.scope,
          root: projection.root,
          variantsPath: options.variantsPath,
          acceptedObservations: accepted,
        });
      }
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
            harness: observation.harness,
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
    }),
  );
});
