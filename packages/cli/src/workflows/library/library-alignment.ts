import { Schema } from "effect";
import {
  Upstream,
  remapEnabled,
  type Enabled,
  type CollectionId,
  type LibraryManifest,
  type LibraryState,
  type SkillId,
  type SkillVersion,
} from "@smolai/skit-core";

/**
 * The remote handles independently created local records adopt: Collections by upstream and
 * tracking, their Skills by path, then equivalent Versions by content. Version aliases name the
 * Skill by its remote ID, so they apply after the Skill aliases.
 */
export interface LibraryAliases {
  readonly collections: readonly { readonly from: CollectionId; readonly to: CollectionId }[];
  readonly skills: readonly { readonly from: SkillId; readonly to: SkillId }[];
  readonly versions: readonly {
    readonly skillId: SkillId;
    readonly from: SkillVersion;
    readonly to: SkillVersion;
  }[];
}

const sameContent = (left: SkillVersion, right: SkillVersion) =>
  left.source_digest === right.source_digest &&
  left.artifact_digest === right.artifact_digest &&
  left.validation_identity_digest === right.validation_identity_digest &&
  left.materialization_profile === right.materialization_profile;

const collectionId = (id: CollectionId, aliases: LibraryAliases) =>
  aliases.collections.find((alias) => alias.from === id)?.to ?? id;
const skillId = (id: SkillId, aliases: LibraryAliases) =>
  aliases.skills.find((alias) => alias.from === id)?.to ?? id;
const aliasEnabled = (item: Enabled, aliases: LibraryAliases): Enabled =>
  "collection" in item
    ? { collection: collectionId(item.collection, aliases) }
    : { skill: skillId(item.skill, aliases) };

/** Apply only observed Version aliases, including to the accepted base; never match by digest. */
const aliasSkills = (skills: LibraryManifest["skills"], aliases: LibraryAliases) =>
  skills.map((skill) => {
    const id = skillId(skill.skill_id, aliases);
    const applicable = aliases.versions.filter(
      (alias) =>
        alias.skillId === id &&
        skill.versions.some(
          (version) =>
            version.skill_version_id === alias.from.skill_version_id &&
            sameContent(version, alias.from),
        ),
    );
    const renamed = (version: SkillVersion["skill_version_id"]) =>
      applicable.find((alias) => alias.from.skill_version_id === version)?.to.skill_version_id ??
      version;
    return {
      ...skill,
      collection_id: collectionId(skill.collection_id, aliases),
      skill_id: id,
      ...(skill.local_version_id === undefined
        ? {}
        : { local_version_id: renamed(skill.local_version_id) }),
      versions: skill.versions.map((version) => ({
        ...version,
        skill_version_id: renamed(version.skill_version_id),
      })),
    };
  });

/**
 * Only independently added Collections may adopt an existing upstream/tracking identity, and only
 * Skills new to both sides adopt a remote Skill at the same path. Equivalent Versions then adopt
 * their remote handles. Remote entities are never renamed.
 */
export function alignLibrary(
  local: LibraryManifest,
  remote: LibraryManifest,
  base: LibraryManifest,
): LibraryAliases {
  const collections: LibraryAliases["collections"][number][] = [];
  const skills: LibraryAliases["skills"][number][] = [];
  for (const collection of local.collections) {
    const upstream = collection.upstream;
    if (
      upstream === undefined ||
      [...base.collections, ...remote.collections].some(
        (item) => item.collection_id === collection.collection_id,
      )
    )
      continue;
    const remoteMatch = remote.collections.find(
      (item) =>
        item.upstream !== undefined && Schema.toEquivalence(Upstream)(upstream, item.upstream),
    );
    if (remoteMatch === undefined) continue;
    collections.push({ from: collection.collection_id, to: remoteMatch.collection_id });
  }
  for (const skill of local.skills) {
    if ([...base.skills, ...remote.skills].some((item) => item.skill_id === skill.skill_id))
      continue;
    const collection =
      collections.find((alias) => alias.from === skill.collection_id)?.to ?? skill.collection_id;
    const counterpart = remote.skills.find(
      (item) => item.collection_id === collection && item.path === skill.path,
    );
    if (
      counterpart !== undefined &&
      !base.skills.some((item) => item.skill_id === counterpart.skill_id)
    )
      skills.push({ from: skill.skill_id, to: counterpart.skill_id });
  }
  const versions: LibraryAliases["versions"][number][] = [];
  for (const skill of aliasSkills(local.skills, { collections, skills, versions: [] })) {
    const remoteMatch = remote.skills.find((candidate) => candidate.skill_id === skill.skill_id);
    for (const version of skill.versions) {
      const equivalent = remoteMatch?.versions.find((candidate) => sameContent(version, candidate));
      if (equivalent !== undefined && equivalent.skill_version_id !== version.skill_version_id)
        versions.push({ skillId: skill.skill_id, from: version, to: equivalent });
    }
  }
  return { collections, skills, versions };
}

export function aliasManifest(manifest: LibraryManifest, aliases: LibraryAliases): LibraryManifest {
  return {
    ...manifest,
    collections: manifest.collections.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    skills: aliasSkills(manifest.skills, aliases),
    imports: manifest.imports.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    enabled: manifest.enabled.map((item) => aliasEnabled(item, aliases)),
  };
}

/**
 * Device references move with the records they name, keeping their content. On-disk ownership of a
 * reidentified Skill must be retired before a state carrying these aliases is saved.
 */
export function aliasDevice(state: LibraryState, aliases: LibraryAliases): LibraryState {
  return {
    ...remapEnabled(state, aliases),
    collections: state.collections.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    skills: aliasSkills(state.skills, aliases),
    imports: state.imports.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    installed_skills: state.installed_skills.map((installedSkill) => {
      const skill = skillId(installedSkill.skill_id, aliases);
      return {
        ...installedSkill,
        skill_id: skill,
        skill_version_id:
          aliases.versions.find(
            (alias) =>
              alias.skillId === skill &&
              alias.from.skill_version_id === installedSkill.skill_version_id,
          )?.to.skill_version_id ?? installedSkill.skill_version_id,
      };
    }),
    ...(state.ownershipIssues === undefined
      ? {}
      : {
          ownershipIssues: state.ownershipIssues.map((issue) => ({
            ...issue,
            ...(issue.skillId === undefined ? {} : { skillId: skillId(issue.skillId, aliases) }),
            ...(issue.collectionId === undefined
              ? {}
              : { collectionId: collectionId(issue.collectionId, aliases) }),
          })),
        }),
    ...(state.assessmentAcceptances === undefined
      ? {}
      : {
          assessmentAcceptances: state.assessmentAcceptances.map((acceptance) => ({
            ...acceptance,
            // A mismatched digest stays stale, including its historical Version handle.
            skill_version_id:
              aliases.versions.find(
                (alias) =>
                  alias.from.skill_version_id === acceptance.skill_version_id &&
                  alias.from.artifact_digest === acceptance.artifactContentDigest,
              )?.to.skill_version_id ?? acceptance.skill_version_id,
          })),
        }),
  };
}
