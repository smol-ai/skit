import type { LibraryManifest, LibraryState, SkillId, SkillVersion } from "@smolai/skit-core";

interface VersionAlias {
  readonly skillId: SkillId;
  readonly from: SkillVersion;
  readonly to: SkillVersion;
}
type VersionAliases = readonly VersionAlias[];

const sameContent = (left: SkillVersion, right: SkillVersion) =>
  left.source_digest === right.source_digest &&
  left.artifact_digest === right.artifact_digest &&
  left.validation_identity_digest === right.validation_identity_digest &&
  left.materialization_profile === right.materialization_profile;

/** Adopt published handles for equivalent Versions; never rename remote entities. */
export function alignLibraryVersionIds(local: LibraryManifest, remote: LibraryManifest) {
  const aliases: VersionAlias[] = [];
  for (const skill of local.skills) {
    const published = remote.skills.find((candidate) => candidate.skill_id === skill.skill_id);
    for (const version of skill.versions) {
      const equivalent = published?.versions.find((candidate) => sameContent(version, candidate));
      if (equivalent !== undefined && equivalent.skill_version_id !== version.skill_version_id)
        aliases.push({ skillId: skill.skill_id, from: version, to: equivalent });
    }
  }
  return { manifest: applyLibraryVersionAliases(local, aliases), aliases };
}

/** Apply only observed aliases, including to the accepted base; never match the base by digest. */
export function applyLibraryVersionAliases<T extends Pick<LibraryManifest, "skills">>(
  manifest: T,
  aliases: VersionAliases,
) {
  return {
    ...manifest,
    skills: manifest.skills.map((skill) => {
      const applicable = aliases.filter(
        (alias) =>
          alias.skillId === skill.skill_id &&
          skill.versions.some(
            (version) =>
              version.skill_version_id === alias.from.skill_version_id &&
              sameContent(version, alias.from),
          ),
      );
      const renamed = (id: SkillVersion["skill_version_id"]) =>
        applicable.find((alias) => alias.from.skill_version_id === id)?.to.skill_version_id ?? id;
      return {
        ...skill,
        ...(skill.local_version_id === undefined
          ? {}
          : { local_version_id: renamed(skill.local_version_id) }),
        versions: skill.versions.map((version) => ({
          ...version,
          skill_version_id: renamed(version.skill_version_id),
        })),
      };
    }),
  };
}

/** Keep device references with the same content while replacing their portable handles. */
export function applyDeviceVersionAliases(
  state: LibraryState,
  aliases: VersionAliases,
): LibraryState {
  const aligned = applyLibraryVersionAliases(state, aliases);
  return {
    ...state,
    skills: aligned.skills,
    projections: state.projections.map((projection) => ({
      ...projection,
      skill_version_id:
        aliases.find(
          (alias) =>
            alias.skillId === projection.skill_id &&
            alias.from.skill_version_id === projection.skill_version_id,
        )?.to.skill_version_id ?? projection.skill_version_id,
    })),
    ...(state.assessmentAcceptances === undefined
      ? {}
      : {
          assessmentAcceptances: state.assessmentAcceptances.map((acceptance) => ({
            ...acceptance,
            // A mismatched digest stays stale, including its historical Version handle.
            skill_version_id:
              aliases.find(
                (alias) =>
                  alias.from.skill_version_id === acceptance.skill_version_id &&
                  alias.from.artifact_digest === acceptance.artifactContentDigest,
              )?.to.skill_version_id ?? acceptance.skill_version_id,
          })),
        }),
  };
}
