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
    (installedSkill) => installedSkill.skill_id === skill.skill_id,
  );
  const selected = yield* matchingInstalledSkill(candidates, selector);
  const currentHash = yield* deterministicTreeHash(selected.path);
  if (currentHash === selected.expected_digest)
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
    const digest = yield* deterministicTreeHash(installedSkill.path);
    installedSkills.push({
      installed_skill_id: installedSkill.installed_skill_id,
      destination: installedSkill.destination,
      path: installedSkill.path,
      current_digest: digest,
      agreement:
        installedSkill.installed_skill_id === selected.installed_skill_id
          ? "selected"
          : digest === currentHash
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
    current_digest: currentHash,
    snapshot_digest: prepared.digest,
    original_path: collectionVersionPath((yield* LibraryStore).originalsPath, prepared.digest),
    import_required: previousVersion.artifact_digest !== currentHash,
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
      installedSkill.destination !== "legacy" &&
      enabledSkillIds(state, enabled).includes(installedSkill.skill_id) &&
      (scope.kind === "global" || resolve(scope.root) === resolve(installedSkill.root)),
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
        (installedSkill) =>
          installedSkill.installed_skill_id === preview.selected_installed_skill_id,
      )!;
      const imported = preview.import_required
        ? yield* Effect.scoped(
            importEdit({
              skillId: preview.skill_id,
              installedSkillId: preview.selected_installed_skill_id,
              path: selected.path,
              currentHash: preview.current_digest,
              importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            }),
          )
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
              return yield* new EditImportStale({
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
        { readonly currentHash: Digest; readonly marker: OwnershipMarker }
      >();
      for (const installedSkill of preview.installed_skills) {
        if (installedSkill.current_digest !== preview.current_digest) continue;
        const marker = yield* inspectOwnershipMarker(installedSkill.path);
        if (marker.kind === "valid")
          accepted.set(installedSkill.installed_skill_id, {
            currentHash: installedSkill.current_digest,
            marker: marker.marker,
          });
      }
      const afterRetention = yield* store.load;
      const reconciled = new Set<string>();
      for (const previewed of preview.installed_skills) {
        const installedSkill = afterRetention.installed_skills.find(
          (candidate) => candidate.installed_skill_id === previewed.installed_skill_id,
        );
        const scope =
          installedSkill === undefined ? undefined : enablingScope(afterRetention, installedSkill);
        if (
          installedSkill === undefined ||
          scope === undefined ||
          installedSkill.destination === "legacy"
        )
          continue;
        const coordinate = `${installedSkill.destination}\0${canonicalJson(scope)}\0${installedSkill.root}`;
        if (reconciled.has(coordinate)) continue;
        reconciled.add(coordinate);
        yield* installEnabledSkills({
          target: installedSkill.destination,
          scope,
          root: installedSkill.root,
          variantsPath: store.variantsPath,
          acceptedCopies: accepted,
        });
      }
      const settled = yield* store.load;
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
