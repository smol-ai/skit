import { Effect, Schema } from "effect";
import { join } from "node:path";
import {
  LibraryManifest,
  enabledSkillIds,
  mergeEnabled,
  type Enabled,
} from "../../library-contracts.js";
import type { LibraryState } from "../../library-state.js";
import { SkillId } from "../../entity-ids.js";
import type { InstallDestination } from "../../../vocabulary.js";
import { installedSkillName } from "../../../installed-skills/files.js";
import { installDestinationPathIdentity } from "../../../platform/path-identity.js";
import { existingRepositorySkillsDirectory } from "../../routing/roots.js";
import { SyncConflictDetail } from "./conflict.js";

const targets = ["agents", "claude"] as const;
const Candidate = Schema.Struct({
  path: Schema.String,
  skill_id: SkillId,
  target: Schema.Literals(targets),
  global: Schema.Boolean,
});

/** Compare destinations using filesystem evidence, including symlink and case aliases. */
export const resolveSyncInstalledSkillCollisions = Effect.fn(
  "Library.sync.installedSkillCollisions",
)(function* (
  manifest: LibraryManifest,
  rootFor: ((target: InstallDestination) => string | undefined) | undefined,
  keepEnabled: readonly string[] = [],
  device?: LibraryState,
) {
  const groups = new Map<string, (typeof Candidate.Type)[]>();
  const enabled = new Set(enabledSkillIds(manifest, manifest.enabled));
  for (const target of targets) {
    const root = rootFor?.(target);
    if (root === undefined) continue;
    for (const skill of manifest.skills.filter((item) => enabled.has(item.skill_id))) {
      const path = join(root, yield* installedSkillName(skill.name));
      const identity = yield* installDestinationPathIdentity(path);
      const group = groups.get(identity.comparisonKey) ?? [];
      group.push({ path, skill_id: skill.skill_id, target, global: true });
      groups.set(identity.comparisonKey, group);
    }
  }
  if (device !== undefined) {
    for (const repository of device.repositories) {
      for (const target of targets) {
        const root = existingRepositorySkillsDirectory(device, repository.root, target);
        if (root === undefined) continue;
        const ids = new Set(enabledSkillIds(manifest, repository.enabled));
        for (const skill of manifest.skills.filter((item) => ids.has(item.skill_id))) {
          const path = join(root, yield* installedSkillName(skill.name));
          const identity = yield* installDestinationPathIdentity(path);
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
  const kept =
    disabled.size === 0
      ? manifest.enabled
      : mergeEnabled(manifest, [
          manifest.enabled.flatMap((item): Enabled[] => {
            const ids = enabledSkillIds(manifest, [item]);
            if (!ids.some((id) => disabled.has(id))) return [item];
            return ids.filter((id) => !disabled.has(id)).map((skill) => ({ skill }));
          }),
        ]);
  return {
    manifest: yield* LibraryManifest.makeEffect({ ...manifest, enabled: kept }),
    conflicts,
    invalid,
  };
});
