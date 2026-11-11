import { LocalStateViolation } from "@smolai/skit-core/library/local-state-violation";

export const localStateViolation = (violation: LocalStateViolation): string =>
  LocalStateViolation.match(violation, {
    RepositoryRootCollision: ({ first, second, canonical }) =>
      `Repository roots ${first} and ${second} refer to the same folder: ${canonical}`,
    InstalledPathCollision: ({ firstId, secondId, firstPath, secondPath, canonical }) =>
      `Installed copies ${firstId} (${firstPath}) and ${secondId} (${secondPath}) refer to the same folder: ${canonical}`,
    InstalledIdDuplicate: ({ installedSkillId }) =>
      `Installed copy ID ${installedSkillId} occurs more than once`,
    RepositorySubjectMissing: ({ root, kind, id }) =>
      `Repository ${root} enables missing ${kind} ${id}`,
    InstalledSkillMissing: ({ installedSkillId, skillId, path }) =>
      `Installed copy ${installedSkillId} at ${path} refers to missing Skill ${skillId}`,
    InstalledVersionMissing: ({ installedSkillId, skillId, versionId, path }) =>
      `Installed copy ${installedSkillId} at ${path} refers to missing Version ${versionId} of Skill ${skillId}`,
  });
