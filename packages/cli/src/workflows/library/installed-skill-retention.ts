import {
  canonicalJson,
  deterministicTreeHash,
  inspectOwnershipMarker,
  LibraryStore,
  libraryStateRevision,
  bindingSkillIds,
  effectiveGlobalBindings,
  currentSkillVersion,
  prepareImport,
  installEnabledSkills,
  retainChangedInstalledSkill,
  retainedTreePath,
  versionBacking,
  withLibraryWriter,
  type LibraryState,
  type InstalledSkill,
  type Digest,
  type OwnershipMarker,
  type DeviceBinding,
  type RepositoryBinding,
  type InstalledSkillId,
} from "@smolai/skit-core";
import { Data, Clock, Effect } from "effect";
import { resolve } from "node:path";
import type {
  InstalledSkillRetentionPlan,
  InstalledSkillRetentionResult,
} from "./installed-skill-retention-contract.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class InstalledSkillRetentionMissing
  extends Data.TaggedError("Library.InstalledSkillRetentionMissing")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Run `skit doctor` to inspect changed installed skills.";
}

export class InstalledSkillRetentionAmbiguous
  extends Data.TaggedError("Library.InstalledSkillRetentionAmbiguous")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Use an exact Projection ID or path with `--from-projection`.";
}

export class InstalledSkillRetentionStale
  extends Data.TaggedError("Library.InstalledSkillRetentionStale")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview retaining the installed skill's changes again.";
}

const matchingSkill = Effect.fn("Library.InstalledSkillRetention.matchSkill")(function* (
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
    return yield* new InstalledSkillRetentionMissing({ message: `No Skill matches ${query}` });
  if (matches.length !== 1)
    return yield* new InstalledSkillRetentionAmbiguous({
      message: `More than one Skill matches ${query}`,
    });
  return matches[0]!;
});

const matchingInstalledSkill = Effect.fn("Library.InstalledSkillRetention.matchInstalledSkill")(
  function* (projections: readonly InstalledSkill[], selector: string) {
    const matches = projections.filter(
      (projection) =>
        projection.projection_id === selector ||
        projection.target === selector ||
        resolve(projection.path) === resolve(selector),
    );
    if (matches.length === 0)
      return yield* new InstalledSkillRetentionMissing({
        message: `No installed skill matches ${selector}`,
      });
    if (matches.length !== 1)
      return yield* new InstalledSkillRetentionAmbiguous({
        message: `More than one installed skill matches ${selector}`,
      });
    return matches[0]!;
  },
);

const planInstalledSkillRetention = Effect.fn("Library.planInstalledSkillRetention")(function* (
  state: LibraryState,
  query: string,
  selector: string,
) {
  const skill = yield* matchingSkill(state, query);
  const previousVersion = currentSkillVersion(state, skill);
  if (previousVersion === undefined)
    return yield* new InstalledSkillRetentionMissing({
      message: `${skill.name} has no selected retained Version`,
    });
  const candidates = state.projections.filter(
    (projection) => projection.skill_id === skill.skill_id,
  );
  const selected = yield* matchingInstalledSkill(candidates, selector);
  const observed = yield* deterministicTreeHash(selected.path);
  if (observed === selected.expected_digest)
    return yield* new InstalledSkillRetentionMissing({
      message: `${selected.path} has not changed from its retained Version`,
    });
  const prepared = yield* Effect.scoped(
    prepareImport([
      {
        name: skill.name,
        sourcePath: selected.path,
        relativePath: ".",
        observedHash: observed,
      },
    ]),
  );
  const observations: Array<InstalledSkillRetentionPlan["projections"][number]> = [];
  for (const projection of candidates) {
    const digest = yield* deterministicTreeHash(projection.path);
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
  } satisfies InstalledSkillRetentionPlan;
});

const bindingForInstalledSkill = (
  state: LibraryState,
  projection: InstalledSkill,
): DeviceBinding | RepositoryBinding | undefined =>
  [...effectiveGlobalBindings(state), ...state.local_bindings].find(
    (binding) =>
      projection.target !== "legacy" &&
      bindingSkillIds(state, binding).includes(projection.skill_id) &&
      (binding.scope.kind === "global" || resolve(binding.scope.root) === resolve(projection.root)),
  );

/** Capture the Library and observations once; callers only render or apply this operation. */
export const prepareInstalledSkillRetention = Effect.fn("Library.prepareInstalledSkillRetention")(
  function* (query: string, selector: string) {
    const store = yield* LibraryStore;
    const initial = yield* store.load;
    const preview = yield* planInstalledSkillRetention(initial, query, selector);
    return {
      preview: structuredClone(preview),
      apply: () => applyPreparedInstalledSkillRetention(store.home, preview, query, selector),
    };
  },
);

const applyPreparedInstalledSkillRetention = Effect.fn("Library.applyInstalledSkillRetention")(
  function* (home: string, preview: InstalledSkillRetentionPlan, query: string, selector: string) {
    const store = yield* LibraryStore;
    if (store.home !== home)
      return yield* new InstalledSkillRetentionStale({
        message: "This retention preview belongs to a different Library",
      });
    return yield* withLibraryWriter(
      Effect.gen(function* () {
        const current = yield* store.load;
        if (libraryStateRevision(current) !== preview.revision)
          return yield* new InstalledSkillRetentionStale({
            message: "Library state changed after the retention was previewed",
          });
        const revalidated = yield* planInstalledSkillRetention(current, query, selector);
        if (canonicalJson(revalidated) !== canonicalJson(preview))
          return yield* new InstalledSkillRetentionStale({
            message: "The installed skill's bytes changed after the retention was previewed",
          });
        const selected = current.projections.find(
          (projection) => projection.projection_id === preview.selected_projection_id,
        )!;
        const retained = preview.retention_required
          ? yield* Effect.scoped(
              retainChangedInstalledSkill({
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
                return yield* new InstalledSkillRetentionStale({
                  message: "Selected retained Version is incomplete",
                });
              return {
                skillVersionId: version.skill_version_id,
                retainedCopyId: acquisition.retained_copy_id,
                snapshotDigest: preview.snapshot_digest,
              };
            });
        const accepted = new Map<
          InstalledSkillId,
          { readonly observedHash: Digest; readonly marker: OwnershipMarker }
        >();
        for (const projection of preview.projections) {
          if (projection.observed_digest !== preview.observed_digest) continue;
          const marker = yield* inspectOwnershipMarker(projection.path);
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
            projection === undefined
              ? undefined
              : bindingForInstalledSkill(afterRetention, projection);
          if (projection === undefined || binding === undefined || projection.target === "legacy")
            continue;
          const coordinate = `${projection.target}\0${canonicalJson(binding.scope)}\0${projection.root}`;
          if (reconciled.has(coordinate)) continue;
          reconciled.add(coordinate);
          yield* installEnabledSkills({
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
              projection === undefined ? undefined : bindingForInstalledSkill(settled, projection);
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
        } satisfies InstalledSkillRetentionResult;
      }),
    );
  },
);
