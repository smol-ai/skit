import * as Library from "../../library.js";
import { canonicalJson } from "../../../shared/json.js";
import { deterministicTreeHash } from "../../../artifact/skit.js";
import { inspectOwnershipMarker } from "../../../installed-skills/marker-inspection.js";
import type { OwnershipMarker } from "../../../installed-skills/ownership-marker.js";
import { libraryOriginalsPath, loadLibrary, writeLibrary } from "../../store/library-store.js";
import { libraryStateRevision, emptyLibraryState, type LibraryState } from "../../library-state.js";
import { type InstalledSkill } from "../../device-state.js";
import { enabledByScope } from "../../enabled.js";
import { enabledSkillIds, currentSkillVersion, versionBacking } from "../../library-contracts.js";
import { prepareImport } from "../../import-collection.js";
import { collectionVersionPath } from "../../collection-version.js";
import type { Hash } from "../../../shared/hash.js";
import type { InstallScope } from "../../scope.js";
import type { InstalledSkillId } from "../../entity-ids.js";
import { Data, Clock, Effect } from "effect";
import { StalePlan } from "../../library-plan.js";
import { resolve } from "node:path";
import type { EditImportPlan, EditImportResult } from "./edit-contract.js";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import type { TreeRequirements } from "../../../platform/tree-requirements.js";
import type { Digest } from "effect/crypto";
export class EditImportMissing
  extends Data.TaggedError("Library.EditImportMissing")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Inspect the changed installed skills.";
}

class EditImportAmbiguous
  extends Data.TaggedError("Library.EditImportAmbiguous")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Use an exact Projection ID or path with `--from-projection`.";
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
  const [match] = matches;
  if (match === undefined)
    return yield* new EditImportMissing({ message: "The selected Skill is missing" });
  return match;
});

const matchingInstalledSkill = Effect.fn("Library.EditImport.matchInstalledSkill")(function* (
  installedSkills: readonly InstalledSkill[],
  selector: string,
) {
  const matches = installedSkills.filter(
    (installedSkill) =>
      installedSkill.installed_skill_id === selector ||
      installedSkill.destination === selector ||
      resolve(installedSkill.path) === resolve(selector),
  );
  if (matches.length === 0)
    return yield* new EditImportMissing({
      message: `No installed skill matches ${selector}`,
    });
  if (matches.length !== 1)
    return yield* new EditImportAmbiguous({
      message: `More than one installed skill matches ${selector}`,
    });
  const [match] = matches;
  if (match === undefined)
    return yield* new EditImportMissing({ message: "The selected Skill is missing" });
  return match;
});

const planEditImport = Effect.fn("Library.planEditImport")(function* (
  home: string,
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
    (installedSkill) => installedSkill.skill_id === skill.skill_id,
  );
  const selected = yield* matchingInstalledSkill(candidates, selector);
  const currentHash = yield* deterministicTreeHash(selected.path);
  if (currentHash === selected.expected_hash)
    return yield* new EditImportMissing({
      message: `${selected.path} has not changed from its retained Version`,
    });
  const prepared = yield* Effect.scoped(
    prepareImport([
      {
        name: skill.name,
        sourcePath: selected.path,
        relativePath: ".",
        currentHash: currentHash,
      },
    ]),
  );
  const installedSkills: Array<EditImportPlan["installed_skills"][number]> = [];
  for (const installedSkill of candidates) {
    const hash = yield* deterministicTreeHash(installedSkill.path);
    installedSkills.push({
      installed_skill_id: installedSkill.installed_skill_id,
      destination: installedSkill.destination,
      path: installedSkill.path,
      current_hash: hash,
      agreement:
        installedSkill.installed_skill_id === selected.installed_skill_id
          ? "selected"
          : hash === currentHash
            ? "identical"
            : "different",
    });
  }
  return {
    revision: libraryStateRevision(state),
    skill_id: skill.skill_id,
    skill_name: skill.name,
    previous_skill_version_id: previousVersion.skill_version_id,
    selected_installed_skill_id: selected.installed_skill_id,
    current_hash: currentHash,
    snapshot_digest: prepared.hash,
    original_path: collectionVersionPath(libraryOriginalsPath(home), prepared.hash),
    import_required: previousVersion.artifact_hash !== currentHash,
    installed_skills: installedSkills,
  } satisfies EditImportPlan;
});

/** The scope whose list enables this installed skill, so an edit is imported under it. */
const enablingScope = (
  state: LibraryState,
  installedSkill: InstalledSkill,
): InstallScope | undefined =>
  enabledByScope(state).find(
    ({ scope, enabled }) =>
      enabledSkillIds(state, enabled).includes(installedSkill.skill_id) &&
      (scope.kind === "global" || resolve(scope.root) === resolve(installedSkill.root)),
  )?.scope;

/** Capture the Library and observations once; callers only render or apply this operation. */
export const openEditImport = Effect.fn("Library.openEditImport")(function* (
  home: string,
  query: string,
  selector: string,
) {
  const library = yield* Library.Service;
  const snapshot = yield* library.read;
  const initial = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
  const context = yield* Effect.context<Library.Service | TreeRequirements | Digest.Digest>();
  const preview = yield* planEditImport(home, initial, query, selector);
  return {
    preview: structuredClone(preview),
    apply: (currentHome: string) =>
      resolve(currentHome) !== resolve(home)
        ? Effect.fail(
            new StalePlan({
              message: "This retention preview belongs to a different Library",
            }),
          )
        : applyEditImport(home, preview, query, selector).pipe(Effect.provide(context)),
  };
}, Effect.scoped);

const applyEditImport = Effect.fn("Library.applyEditImport")(function* (
  home: string,
  preview: EditImportPlan,
  query: string,
  selector: string,
) {
  return yield* writeLibrary(
    home,
    Effect.gen(function* () {
      const current = yield* loadLibrary(home);
      if (libraryStateRevision(current) !== preview.revision)
        return yield* new StalePlan({
          message: "Library state changed after the retention was previewed",
        });
      const revalidated = yield* planEditImport(home, current, query, selector);
      if (canonicalJson(revalidated) !== canonicalJson(preview))
        return yield* new StalePlan({
          message: "The installed skill's bytes changed after the retention was previewed",
        });
      const selected = current.installed_skills.find(
        (installedSkill) =>
          installedSkill.installed_skill_id === preview.selected_installed_skill_id,
      );
      if (selected === undefined)
        return yield* new StalePlan({
          message: "The reviewed installed Skill is no longer recorded",
        });
      const library = yield* Library.Service;
      const imported = preview.import_required
        ? yield* library.import.edit({
            skillId: preview.skill_id,
            installedSkillId: preview.selected_installed_skill_id,
            path: selected.path,
            currentHash: preview.current_hash,
            importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          })
        : yield* Effect.gen(function* () {
            const skill = current.skills.find(
              (candidate) => candidate.skill_id === preview.skill_id,
            );
            const version = skill === undefined ? undefined : currentSkillVersion(current, skill);
            const sourceImport =
              skill === undefined || version === undefined
                ? undefined
                : versionBacking(current, skill, version)?.acquisition;
            if (version === undefined || sourceImport === undefined)
              return yield* new StalePlan({
                message: "Selected retained Version is incomplete",
              });
            return {
              skillVersionId: version.skill_version_id,
              collectionVersionId: sourceImport.collection_version_id,
              snapshotDigest: preview.snapshot_digest,
            };
          });
      const accepted = new Map<
        InstalledSkillId,
        { readonly currentHash: Hash; readonly marker: OwnershipMarker }
      >();
      for (const installedSkill of preview.installed_skills) {
        if (installedSkill.current_hash !== preview.current_hash) continue;
        const marker = yield* inspectOwnershipMarker(installedSkill.path);
        if (marker.kind === "valid")
          accepted.set(installedSkill.installed_skill_id, {
            currentHash: installedSkill.current_hash,
            marker: marker.marker,
          });
      }
      if (preview.installed_skills.length > 0) {
        const snapshot = yield* library.read;
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan(
            { _tag: "Update" },
            {
              base: snapshot,
              approvals: [...accepted].map(([installedSkillId, copy]) => ({
                _tag: "AcceptEdit" as const,
                installedSkillId,
                ...copy,
              })),
            },
          ),
        });
      }
      const settled = yield* loadLibrary(home);
      return {
        skill_id: preview.skill_id,
        skill_name: preview.skill_name,
        previous_skill_version_id: preview.previous_skill_version_id,
        imported_skill_version_id: imported.skillVersionId,
        collection_version_id: imported.collectionVersionId,
        snapshot_digest: imported.snapshotDigest,
        imported: preview.import_required,
        installed_skills: preview.installed_skills.map((previewed) => {
          const installedSkill = settled.installed_skills.find(
            (candidate) => candidate.installed_skill_id === previewed.installed_skill_id,
          );
          const scope =
            installedSkill === undefined ? undefined : enablingScope(settled, installedSkill);
          return {
            installed_skill_id: previewed.installed_skill_id,
            destination: previewed.destination,
            path: previewed.path,
            status:
              scope === undefined
                ? ("deferred" as const)
                : installedSkill?.status === "installed"
                  ? ("installed" as const)
                  : ("conflicted" as const),
          };
        }),
      } satisfies EditImportResult;
    }),
  );
});

export type { EditImportAmbiguous };
