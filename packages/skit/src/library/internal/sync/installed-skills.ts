import { Effect, Schema } from "effect";
import * as InstalledSkillStatus from "../../installed-skill-status.js";
import { LibraryManifest, enabledSkillIds, currentSkillVersion } from "../../library-contracts.js";
import { InstalledSkill } from "../../device-state.js";
import { type LibraryState } from "../../library-state.js";

import { InstalledSkillId } from "../../entity-ids.js";
import type { InstallDestination } from "../../../installed-skills/destination.js";
import { inspectInstalledSkill } from "../../../installed-skills/files.js";
import { installDestinationPathIdentity } from "../../../platform/path-identity.js";
import { repositorySelectsInstalledSkill } from "../../installation/uninstall.js";
import { SyncConflictDetail } from "./conflict.js";

const targets = ["agents", "claude"] as const;

export const SyncInstalledSkillsPreview = Schema.Struct({
  projections: Schema.Array(InstalledSkill),
  retire: Schema.Array(InstalledSkillId),
  remove: Schema.Array(InstalledSkillId),
  conflicts: Schema.Array(SyncConflictDetail),
  issues: Schema.Array(SyncConflictDetail),
});
export type SyncInstalledSkillsPreview = typeof SyncInstalledSkillsPreview.Type;

/** Preview every affected copy, including repository custody, before any remote write. */
export const previewSyncInstalledSkills = Effect.fn("Library.sync.planInstalledSkills")(function* (
  current: LibraryState,
  aligned: LibraryState,
  manifest: LibraryManifest,
  rootFor: ((target: InstallDestination) => string | undefined) | undefined,
  deferDeviceConflicts: boolean,
) {
  const installedSkills: InstalledSkill[] = [];
  const toUninstall: InstalledSkillId[] = [];
  const remove: InstalledSkillId[] = [];
  const conflicts: SyncConflictDetail[] = [];
  const issues: SyncConflictDetail[] = [];
  const enabledIds = new Set(
    [manifest.enabled, ...aligned.repositories.map((repository) => repository.enabled)].flatMap(
      (enabled) => enabledSkillIds(manifest, enabled),
    ),
  );
  for (const skill of manifest.skills) {
    if (!enabledIds.has(skill.skill_id) || currentSkillVersion(manifest, skill) !== undefined)
      continue;
    const repositorySelected = aligned.repositories.some((repository) =>
      enabledSkillIds(manifest, repository.enabled).includes(skill.skill_id),
    );
    (deferDeviceConflicts && !repositorySelected ? issues : conflicts).push(
      SyncConflictDetail.make({
        key: `skill:${skill.skill_id}:no-selected-version`,
        message: `${skill.name} has no selected retained Version. Update it or disable its Binding before syncing.`,
        resolution: "local",
      }),
    );
  }
  for (const repository of aligned.repositories) {
    if (
      repository.enabled.every((item) =>
        "skill" in item
          ? manifest.skills.some((skill) => skill.skill_id === item.skill)
          : manifest.collections.some((collection) => collection.collection_id === item.collection),
      )
    )
      continue;
    conflicts.push(
      SyncConflictDetail.make({
        key: `device:${repository.root}:repository-binding`,
        message: `The repository at ${repository.root} still enables something removed. Disable it there before syncing.`,
        resolution: "local",
      }),
    );
  }
  for (const original of current.installed_skills) {
    const installedSkill = aligned.installed_skills.find(
      (item) => item.installed_skill_id === original.installed_skill_id,
    );
    if (installedSkill === undefined) continue;
    const skill = manifest.skills.find((item) => item.skill_id === installedSkill.skill_id);
    const selected = skill === undefined ? undefined : currentSkillVersion(manifest, skill);
    const global = enabledSkillIds(manifest, manifest.enabled).includes(installedSkill.skill_id);
    const repository = repositorySelectsInstalledSkill(aligned, installedSkill);
    const activeTarget = targets.find((target) => target === installedSkill.destination);
    const active =
      activeTarget !== undefined && (rootFor === undefined || rootFor(activeTarget) !== undefined);
    const removing = !active || (!global && !repository);
    const reidentifying = original.skill_id !== installedSkill.skill_id;
    const missingVersion = !skill?.versions.some(
      (version) => version.skill_version_id === installedSkill.skill_version_id,
    );
    const root =
      global && !repository && activeTarget !== undefined ? rootFor?.(activeTarget) : undefined;
    const relocating =
      root !== undefined &&
      (yield* installDestinationPathIdentity(root)).comparisonKey !==
        (yield* installDestinationPathIdentity(installedSkill.root)).comparisonKey;
    const changing =
      removing ||
      reidentifying ||
      missingVersion ||
      relocating ||
      (selected !== undefined && selected.skill_version_id !== installedSkill.skill_version_id);
    if (changing) {
      const ownership = yield* inspectInstalledSkill(original);
      if (ownership.kind === "conflicted") {
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
              key: `device:${original.installed_skill_id}:modified-projection`,
              message: `Cannot retire modified Skill at ${original.path}. Save the edited directory outside the skills directory, then restore the managed copy before retrying.`,
              resolution: "local",
            }),
          );
          installedSkills.push(
            InstalledSkillStatus.conflicted(installedSkill, ownership.currentHash),
          );
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
          installedSkills.push(
            InstalledSkillStatus.conflicted(
              missingVersion && selected !== undefined
                ? { ...installedSkill, skill_version_id: selected.skill_version_id }
                : installedSkill,
              ownership.currentHash,
            ),
          );
          continue;
        }
        conflicts.push(
          SyncConflictDetail.make({
            key: `device:${original.installed_skill_id}:modified-projection`,
            message: `Sync would replace or remove ${original.path}, whose bytes or ownership changed. Save the edited directory outside the skills directory, then restore the managed copy before syncing.`,
            resolution: "local",
          }),
        );
        installedSkills.push(installedSkill);
        continue;
      }
    }
    if (removing) {
      remove.push(original.installed_skill_id);
      toUninstall.push(original.installed_skill_id);
      continue;
    }
    if (missingVersion && selected === undefined) {
      conflicts.push(
        SyncConflictDetail.make({
          key: `device:${original.installed_skill_id}:managed-projection`,
          message: `No retained Version can replace ${original.path}.`,
          resolution: "local",
        }),
      );
      installedSkills.push(installedSkill);
      continue;
    }
    if (reidentifying) toUninstall.push(original.installed_skill_id);
    const versioned =
      missingVersion && selected !== undefined
        ? { ...installedSkill, skill_version_id: selected.skill_version_id }
        : installedSkill;
    installedSkills.push(
      reidentifying && versioned.status !== "suppressed"
        ? InstalledSkillStatus.pending(versioned)
        : versioned,
    );
  }
  return yield* SyncInstalledSkillsPreview.makeEffect({
    projections: installedSkills,
    retire: toUninstall,
    remove,
    conflicts,
    issues,
  });
});
