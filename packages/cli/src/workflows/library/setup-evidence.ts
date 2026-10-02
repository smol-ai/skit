import type { LibraryState, MachineId } from "@smolai/skit-core";
import { setupLockGroupKey, resolveSkillsShSelectedSource } from "./skills-sh-lock-source.js";
import type { SetupSkillInstance } from "./setup-contract.js";
export interface SetupRetainedEvidence {
  readonly library?: LibraryState;
  readonly machineId?: MachineId;
}

export const lockEvidenceKey = (
  path: string,
  hash: string,
  name: string,
  skillPath: string | undefined,
  validationHash: string,
) => [path, hash, name, skillPath ?? "", validationHash].join("\0");

/** Join each acquisition's lock observations to retained versions on this machine. */
export const indexSetupOnboardingEvidence = (
  instances: readonly SetupSkillInstance[],
  retained?: SetupRetainedEvidence,
) => {
  const library = retained?.library;
  const retainedByLockEvidence = new Map<string, Set<string>>();
  if (library && retained?.machineId)
    for (const acquisition of library.acquisitions) {
      const observations = acquisition.observations.filter(
        (observation) => observation.machine_id === retained.machineId,
      );
      if (!observations.length) continue;
      const members = library.retained_copies
        .filter((copy) => copy.retained_copy_id === acquisition.retained_copy_id)
        .flatMap((copy) => copy.members);
      for (const skill of library.skills.filter(
        (skill) => skill.collection_id === acquisition.collection_id,
      ))
        for (const version of skill.versions) {
          const path = acquisition.kind === "source" ? skill.path : ".";
          if (
            !members.some(
              (member) =>
                member.source_path === path && member.artifact_digest === version.artifact_digest,
            )
          )
            continue;
          for (const observation of observations) {
            const key = lockEvidenceKey(
              observation.lock_path.value,
              observation.lock_content_hash,
              observation.skill_name,
              observation.skill_path,
              version.validation_identity_digest,
            );
            const subjects = retainedByLockEvidence.get(key) ?? new Set<string>();
            subjects.add(skill.collection_id ?? skill.skill_id);
            retainedByLockEvidence.set(key, subjects);
          }
        }
    }
  const locksByGroup = new Map<
    string,
    { lock: SetupSkillInstance["locks"][number]; name: string }[]
  >();
  for (const instance of instances)
    for (const lock of instance.locks) {
      const key = setupLockGroupKey(lock);
      if (key === undefined) continue;
      const group = locksByGroup.get(key) ?? [];
      group.push({ lock, name: instance.name });
      locksByGroup.set(key, group);
    }
  const lockClaims = new Map(
    [...locksByGroup].map(([key, locks]) => [key, resolveSkillsShSelectedSource(locks)] as const),
  );
  return { retainedByLockEvidence, lockClaims };
};

export type SetupOnboardingEvidence = ReturnType<typeof indexSetupOnboardingEvidence>;
