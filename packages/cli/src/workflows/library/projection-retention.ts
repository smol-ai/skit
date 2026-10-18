import {
  canonicalJson,
  deterministicTreeHashEffect,
  originalTreeHashEffect,
  inspectOwnershipMarkerEffect,
  LibraryStore,
  libraryStateRevision,
  bindingSkillIds,
  currentSkillVersion,
  prepareObservedCollectionEffect,
  projectBindingEffect,
  projectionWorkDirectoryEffect,
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
} from "@smolai/skit-core";
import { Data, Clock, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type {
  ProjectionRetentionPlan,
  ProjectionRetentionResult,
  ProjectionRepair,
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

export class ProjectionRepairFailed
  extends Data.TaggedError("Library.ProjectionRepairFailed")<{ directory: string; cause: unknown }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message(): string {
    return `Could not finish replacing the installed copy: ${String(this.cause)}`;
  }
  get remediation(): string {
    return `Run skit doctor and inspect ${this.directory} for a pending backup before retrying.`;
  }
}

/** Bind the review to Library state and verbatim skill files, including ownership markers. */
export const projectionReviewToken = Effect.fn("Library.projectionReviewToken")(function* (
  preview: ProjectionRetentionPlan,
) {
  const copies = yield* Effect.forEach(preview.projections, (projection) =>
    originalTreeHashEffect(projection.path),
  );
  return createHash("sha256").update(canonicalJson({ preview, copies })).digest("hex");
});

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
  return state.global_bindings.find((binding) =>
    bindingSkillIds(state, binding).includes(projection.skill_id),
  );
};

/** Revalidate the reviewed copy under the writer; core moves the old copy to a kept backup. */
export const useLibraryProjection = Effect.fn("Library.useLibraryProjection")(function* (
  preview: ProjectionRetentionPlan,
  query: string,
  selector: string,
  expectedToken: string,
) {
  const store = yield* LibraryStore;
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* store.load;
      if (libraryStateRevision(state) !== preview.revision)
        return yield* new ProjectionRetentionStale({ message: "Library changed after review" });
      const revalidated = yield* observeProjectionRetention(state, query, selector);
      if (canonicalJson(revalidated) !== canonicalJson(preview))
        return yield* new ProjectionRetentionStale({ message: "Copies changed after review" });
      if ((yield* projectionReviewToken(revalidated)) !== expectedToken)
        return yield* new ProjectionRetentionStale({
          message: "Reviewed files changed after review",
        });
      const projection = state.projections.find(
        (item) => item.projection_id === preview.selected_projection_id,
      );
      const binding = projection && bindingForProjection(state, projection);
      if (!projection || !binding || projection.target === "legacy")
        return yield* new ProjectionRetentionMissing({
          message: "The selected copy is not enabled",
        });
      const marker = yield* inspectOwnershipMarkerEffect(projection.path);
      if (
        marker.kind !== "valid" ||
        marker.marker.projection_id !== projection.projection_id ||
        marker.marker.skill_id !== projection.skill_id ||
        marker.marker.expected_digest !== projection.expected_digest
      )
        return yield* new ProjectionRetentionStale({
          message: "The installed copy's ownership marker changed",
        });
      const directory = join(
        yield* projectionWorkDirectoryEffect(projection.root),
        ".skit-backups",
      );
      const before = yield* fs
        .readDirectory(directory)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
          ),
        );
      const existingBackups = new Set<string>(before);
      yield* projectBindingEffect({
        target: projection.target,
        scope: binding.scope,
        root: projection.root,
        variantsPath: store.variantsPath,
        onlyProjection: { projectionId: projection.projection_id, skillId: projection.skill_id },
        acceptedObservations: new Map([
          [
            projection.projection_id,
            {
              observedHash: preview.observed_digest,
              marker: marker.marker,
              allowDifferent: true,
            },
          ],
        ]),
      }).pipe(Effect.mapError((cause) => new ProjectionRepairFailed({ directory, cause })));
      // Reporting is best effort after the write; it must not turn a completed replacement into failure.
      const settled = yield* store.load.pipe(Effect.orElseSucceed(() => undefined));
      const after = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => undefined));
      const backup = after?.find(
        (name) =>
          !existingBackups.has(name) &&
          (name.startsWith(`kept-${projection.projection_id}-`) ||
            name.startsWith(`pending-${projection.projection_id}-`)),
      );
      const installed = settled?.projections.find(
        (item) => item.projection_id === projection.projection_id,
      );
      return {
        skill_id: preview.skill_id,
        skill_name: preview.skill_name,
        path: projection.path,
        status:
          installed === undefined
            ? "unknown"
            : installed.status === "installed"
              ? "installed"
              : "conflicted",
        ...(backup
          ? { backup_path: join(directory, backup), backup_status: "saved" }
          : {
              backup_status:
                installed?.status === "installed" &&
                installed.expected_digest === preview.observed_digest
                  ? "not-needed"
                  : "unavailable",
            }),
      } satisfies ProjectionRepair;
    }),
  );
});

/** Capture the Library and observations once; callers only render or apply this operation. */
export const prepareProjectionRetention = Effect.fn("Library.prepareProjectionRetention")(
  function* (query: string, selector: string) {
    const store = yield* LibraryStore;
    const initial = yield* store.load;
    const preview = yield* observeProjectionRetention(initial, query, selector);
    return {
      preview: structuredClone(preview),
      apply: () => applyPreparedProjectionRetention(store.home, preview, query, selector),
    };
  },
);

/** Locate the two reviewed trees without changing either; apply still revalidates the preview. */
export const projectionComparisonPaths = Effect.fn("Library.projectionComparisonPaths")(function* (
  preview: ProjectionRetentionPlan,
) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  if (libraryStateRevision(state) !== preview.revision)
    return yield* new ProjectionRetentionStale({ message: "Library changed before comparison" });
  const skill = state.skills.find((item) => item.skill_id === preview.skill_id);
  const projection = state.projections.find(
    (item) => item.projection_id === preview.selected_projection_id,
  );
  const version = skill && currentSkillVersion(state, skill);
  const backing = skill && version && versionBacking(state, skill, version);
  if (!skill || !projection || !version || !backing)
    return yield* new ProjectionRetentionMissing({ message: "The selected copy is unavailable" });
  const root = retainedTreePath(store.originalsPath, backing.copy.digest);
  const libraryPath =
    backing.member.source_path === "." ? root : join(root, backing.member.source_path);
  if ((yield* originalTreeHashEffect(libraryPath)) !== version.source_digest)
    return yield* new ProjectionRetentionStale({ message: "The retained Library source changed" });
  if ((yield* deterministicTreeHashEffect(projection.path)) !== preview.observed_digest)
    return yield* new ProjectionRetentionStale({
      message: "The installed copy changed before comparison",
    });
  return { libraryPath, installedPath: projection.path };
});

const applyPreparedProjectionRetention = Effect.fn("Library.applyProjectionRetention")(function* (
  home: string,
  preview: ProjectionRetentionPlan,
  query: string,
  selector: string,
) {
  const store = yield* LibraryStore;
  if (store.home !== home)
    return yield* new ProjectionRetentionStale({
      message: "Projection retention belongs to a different Library",
    });
  return yield* withLibraryWriter(
    Effect.gen(function* () {
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
            const skill = current.skills.find(
              (candidate) => candidate.skill_id === preview.skill_id,
            );
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
      const afterRetention = yield* store.load;
      const reconciled = new Set<string>();
      for (const observation of preview.projections) {
        const projection = afterRetention.projections.find(
          (candidate) => candidate.projection_id === observation.projection_id,
        );
        const binding =
          projection === undefined ? undefined : bindingForProjection(afterRetention, projection);
        if (projection === undefined || binding === undefined || projection.target === "legacy")
          continue;
        const coordinate = `${projection.target}\0${canonicalJson(binding.scope)}\0${projection.root}`;
        if (reconciled.has(coordinate)) continue;
        reconciled.add(coordinate);
        yield* projectBindingEffect({
          target: projection.target,
          scope: binding.scope,
          root: projection.root,
          variantsPath: store.variantsPath,
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
    }),
  );
});
