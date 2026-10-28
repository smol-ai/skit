import {
  canonicalJson,
  deterministicTreeHash,
  inspectOwnershipMarker,
  LibraryStore,
  libraryStateRevision,
  enabledByScope,
  enabledSkillIds,
  currentSkillVersion,
  prepareImport,
  installEnabledSkills,
  importEdit,
  collectionVersionPath,
  versionBacking,
  withLibraryWriter,
  type LibraryState,
  type InstalledSkill,
  type Digest,
  type OwnershipMarker,
  type InstallScope,
  type InstalledSkillId,
} from "@smolai/skit-core";
import { Data, Clock, Effect } from "effect";
import { resolve } from "node:path";
import type { EditImportPlan, EditImportResult } from "./import-edit-contract.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class EditImportMissing
  extends Data.TaggedError("Library.EditImportMissing")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Run `skit doctor` to inspect changed installed skills.";
}

export class EditImportAmbiguous
  extends Data.TaggedError("Library.EditImportAmbiguous")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Use an exact Projection ID or path with `--from-projection`.";
}

export class EditImportStale
  extends Data.TaggedError("Library.EditImportStale")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview retaining the installed skill's changes again.";
}

const matchingSkill = Effect.fn("Library.EditImport.matchSkill")(function* (
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
    return yield* new EditImportMissing({ message: `No Skill matches ${query}` });
  if (matches.length !== 1)
    return yield* new EditImportAmbiguous({
      message: `More than one Skill matches ${query}`,
    });
  return matches[0]!;
});

const matchingInstalledSkill = Effect.fn("Library.EditImport.matchInstalledSkill")(function* (
  projections: readonly InstalledSkill[],
  selector: string,
) {
  const matches = projections.filter(
    (projection) =>
      projection.installed_skill_id === selector ||
      projection.destination === selector ||
      resolve(projection.path) === resolve(selector),
  );
  if (matches.length === 0)
    return yield* new EditImportMissing({
      message: `No installed skill matches ${selector}`,
    });
  if (matches.length !== 1)
    return yield* new EditImportAmbiguous({
      message: `More than one installed skill matches ${selector}`,
    });
  return matches[0]!;
});

const planEditImport = Effect.fn("Library.planEditImport")(function* (
  state: LibraryState,
  query: string,
  selector: string,
) {
  const skill = yield* matchingSkill(state, query);
  const previousVersion = currentSkillVersion(state, skill);
  if (previousVersion === undefined)
    return yield* new EditImportMissing({
      message: `${skill.name} has no selected retained Version`,
    });
  const candidates = state.installed_skills.filter(
    (projection) => projection.skill_id === skill.skill_id,
  );
  const selected = yield* matchingInstalledSkill(candidates, selector);
  const observed = yield* deterministicTreeHash(selected.path);
  if (observed === selected.expected_digest)
    return yield* new EditImportMissing({
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
  const observations: Array<EditImportPlan["projections"][number]> = [];
  for (const projection of candidates) {
    const digest = yield* deterministicTreeHash(projection.path);
    observations.push({
      projection_id: projection.installed_skill_id,
      target: projection.destination,
      path: projection.path,
      observed_digest: digest,
      agreement:
        projection.installed_skill_id === selected.installed_skill_id
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
    selected_projection_id: selected.installed_skill_id,
    observed_digest: observed,
    snapshot_digest: prepared.digest,
    retained_path: collectionVersionPath((yield* LibraryStore).originalsPath, prepared.digest),
    retention_required: previousVersion.artifact_digest !== observed,
    projections: observations,
  } satisfies EditImportPlan;
});

/** The scope whose list enables this installed skill, so an edit is imported under it. */
const enablingScope = (state: LibraryState, projection: InstalledSkill): InstallScope | undefined =>
  enabledByScope(state).find(
    ({ scope, enabled }) =>
      projection.destination !== "legacy" &&
      enabledSkillIds(state, enabled).includes(projection.skill_id) &&
      (scope.kind === "global" || resolve(scope.root) === resolve(projection.root)),
  )?.scope;

/** Capture the Library and observations once; callers only render or apply this operation. */
export const prepareEditImport = Effect.fn("Library.prepareEditImport")(function* (
  query: string,
  selector: string,
) {
  const store = yield* LibraryStore;
  const initial = yield* store.load;
  const preview = yield* planEditImport(initial, query, selector);
  return {
    preview: structuredClone(preview),
    apply: () => applyEditImport(store.home, preview, query, selector),
  };
});

const applyEditImport = Effect.fn("Library.applyEditImport")(function* (
  home: string,
  preview: EditImportPlan,
  query: string,
  selector: string,
) {
  const store = yield* LibraryStore;
  if (store.home !== home)
    return yield* new EditImportStale({
      message: "This retention preview belongs to a different Library",
    });
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const current = yield* store.load;
      if (libraryStateRevision(current) !== preview.revision)
        return yield* new EditImportStale({
          message: "Library state changed after the retention was previewed",
        });
      const revalidated = yield* planEditImport(current, query, selector);
      if (canonicalJson(revalidated) !== canonicalJson(preview))
        return yield* new EditImportStale({
          message: "The installed skill's bytes changed after the retention was previewed",
        });
      const selected = current.installed_skills.find(
        (projection) => projection.installed_skill_id === preview.selected_projection_id,
      )!;
      const retained = preview.retention_required
        ? yield* Effect.scoped(
            importEdit({
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
              return yield* new EditImportStale({
                message: "Selected retained Version is incomplete",
              });
            return {
              skillVersionId: version.skill_version_id,
              retainedCopyId: acquisition.collection_version_id,
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
        const projection = afterRetention.installed_skills.find(
          (candidate) => candidate.installed_skill_id === observation.projection_id,
        );
        const scope =
          projection === undefined ? undefined : enablingScope(afterRetention, projection);
        if (projection === undefined || scope === undefined || projection.destination === "legacy")
          continue;
        const coordinate = `${projection.destination}\0${canonicalJson(scope)}\0${projection.root}`;
        if (reconciled.has(coordinate)) continue;
        reconciled.add(coordinate);
        yield* installEnabledSkills({
          target: projection.destination,
          scope,
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
          const projection = settled.installed_skills.find(
            (candidate) => candidate.installed_skill_id === observation.projection_id,
          );
          const scope = projection === undefined ? undefined : enablingScope(settled, projection);
          return {
            projection_id: observation.projection_id,
            target: observation.target,
            path: observation.path,
            status:
              scope === undefined
                ? ("deferred" as const)
                : projection?.status === "installed"
                  ? ("projected" as const)
                  : ("conflicted" as const),
          };
        }),
      } satisfies EditImportResult;
    }),
  );
});
