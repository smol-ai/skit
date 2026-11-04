import { Clock, Effect, FileSystem } from "effect";
import { join } from "node:path";
import type { SkillSecurityReview } from "../../../contracts.js";
import { ContentAddressCollision, UnknownInstalledSkill } from "../../../failures.js";
import { auditSkill, evaluateSkillAudit } from "../../../auditing/skill-audit.js";
import type { LibraryState } from "../../library-state.js";
import {
  currentCollectionSkills,
  currentSkillVersion,
  versionBacking,
} from "../../library-contracts.js";
import { parseSkillFrontmatter } from "../../../harnesses/frontmatter.js";
import { collectionVersionPath, originalTreeHash } from "../../collection-version.js";

export const securitySkill = Effect.fn("Library.securitySkill")(function* (
  state: LibraryState,
  query: string,
) {
  const matches = state.collections.flatMap((collection) => {
    const collectionMatch = [collection.collection_id, collection.label].includes(query);
    return state.skills
      .filter((candidate) => candidate.collection_id === collection.collection_id)
      .flatMap((skill) => {
        const version = currentSkillVersion(state, skill);
        if (version === undefined) return [];
        if (
          !collectionMatch &&
          skill.name !== query &&
          skill.skill_id !== query &&
          version.skill_version_id !== query
        )
          return [];
        const backing = versionBacking(state, skill, version);
        return backing === undefined
          ? []
          : [{ version, skill, member: backing.member, tree: backing.copy }];
      });
  });
  // A Skill that moved upstream leaves a retired row with the same name; the current one wins.
  const current = matches.filter((match) =>
    currentCollectionSkills(state, match.skill.collection_id).includes(match.skill),
  );
  const [match, ...others] = matches.length > 1 && current.length > 0 ? current : matches;
  if (match === undefined || others.length > 0) return yield* new UnknownInstalledSkill({ query });
  return match;
});

export const securityReview = Effect.fn("Library.securityReviewSnapshot")(function* (
  state: LibraryState,
  originalsPath: string,
  query: string,
) {
  const { version, member, tree } = yield* securitySkill(state, query);
  const originalPath = collectionVersionPath(originalsPath, tree.hash);
  if ((yield* originalTreeHash(originalPath)) !== tree.hash)
    return yield* new ContentAddressCollision();
  const skillPath =
    member.source_path === "." ? originalPath : join(originalPath, member.source_path);
  const text = yield* (yield* FileSystem.FileSystem).readFileString(join(skillPath, "SKILL.md"));
  const frontmatter = parseSkillFrontmatter(text);
  const declaredCapabilities = Array.isArray(frontmatter?.capabilities)
    ? frontmatter.capabilities.filter(
        (capability): capability is string => typeof capability === "string",
      )
    : [];
  const audit = auditSkill(text, {
    declaredCapabilities,
    path: "SKILL.md",
    fingerprintPath: "SKILL.md",
    artifactContentHash: version.artifact_hash,
  });
  const evaluatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const acceptances = state.assessmentAcceptances ?? [];
  return {
    skill_version_id: version.skill_version_id,
    artifactContentHash: version.artifact_hash,
    audit,
    assessment: evaluateSkillAudit(audit, {
      context: "project",
      artifactContentHash: version.artifact_hash,
      acceptances,
      evaluatedAt,
    }),
    acceptances: acceptances
      .filter((acceptance) => acceptance.skill_version_id === version.skill_version_id)
      .map((acceptance) => ({
        ...acceptance,
        status:
          acceptance.artifactContentHash !== version.artifact_hash
            ? ("stale_digest" as const)
            : acceptance.expiresAt && evaluatedAt >= acceptance.expiresAt
              ? ("expired" as const)
              : ("applicable" as const),
      })),
  } satisfies SkillSecurityReview;
});
