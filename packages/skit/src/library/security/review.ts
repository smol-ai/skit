import { Clock, Effect, FileSystem } from "effect";
import { join } from "node:path";
import type { Digest, SkillAssessmentAcceptance, SkillSecurityReview } from "../../contracts.js";
import {
  AcceptanceIncomplete,
  SecurityFindingAbsent,
  UnknownInstalledSkill,
} from "../../failures.js";
import { LibraryStore } from "../store/library-store.js";
import { auditSkill, evaluateSkillAudit } from "../../auditing/skill-audit.js";
import type { LibraryState } from "../library-state.js";
import { parseSkillFrontmatter } from "../../harnesses/frontmatter.js";
import { retainedTreePath } from "../retention/retain-tree.js";

const securitySkill = Effect.fn("Library.securitySkill")(function* (
  state: LibraryState,
  query: string,
) {
  const matches = state.collections.flatMap((collection) => {
    const collectionMatch = [collection.collection_id, collection.label].includes(query);
    return state.skills
      .filter((candidate) => candidate.collection_id === collection.collection_id)
      .flatMap((skill) => {
        const version = skill?.versions.find(
          (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
        );
        if (skill === undefined || version === undefined) return [];
        if (
          !collectionMatch &&
          skill.name !== query &&
          skill.skill_id !== query &&
          version.skill_version_id !== query
        )
          return [];
        const origin = version.origins[0];
        const acquisition = state.acquisitions.find(
          (candidate) => candidate.acquisition_id === origin?.acquisition_id,
        );
        const tree = state.retained_copies.find(
          (candidate) => candidate.retained_copy_id === acquisition?.retained_copy_id,
        );
        const member = tree?.members.find(
          (candidate) => candidate.source_path === origin?.source_path,
        );
        return member === undefined || tree === undefined ? [] : [{ version, skill, member, tree }];
      });
  });
  if (matches.length !== 1) return yield* new UnknownInstalledSkill({ query });
  return matches[0]!;
});

export const securityReviewFromStateEffect = Effect.fn("Library.securityReviewSnapshot")(function* (
  state: LibraryState,
  query: string,
) {
  const store = yield* LibraryStore;
  const { version, member, tree } = yield* securitySkill(state, query);
  const originalPath = retainedTreePath(store.originalsPath, tree.digest);
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
    artifactContentDigest: version.artifact_digest,
  });
  const evaluatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const acceptances = state.assessmentAcceptances ?? [];
  return {
    skill_version_id: version.skill_version_id,
    artifactContentDigest: version.artifact_digest,
    audit,
    assessment: evaluateSkillAudit(audit, {
      context: "project",
      artifactContentDigest: version.artifact_digest,
      acceptances,
      evaluatedAt,
    }),
    acceptances: acceptances
      .filter((acceptance) => acceptance.skill_version_id === version.skill_version_id)
      .map((acceptance) => ({
        ...acceptance,
        status:
          acceptance.artifactContentDigest !== version.artifact_digest
            ? ("stale_digest" as const)
            : acceptance.expiresAt && evaluatedAt >= acceptance.expiresAt
              ? ("expired" as const)
              : ("applicable" as const),
      })),
  } satisfies SkillSecurityReview;
});

export const acceptSecurityFindingFromStateEffect = Effect.fn(
  "Library.acceptSecurityFindingSnapshot",
)(function* (
  state: LibraryState,
  query: string,
  input: {
    readonly fingerprint: Digest;
    readonly principal: string;
    readonly rationale: string;
    readonly expiresAt?: string;
  },
) {
  const acceptedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  if (!input.principal.trim() || !input.rationale.trim())
    return yield* new AcceptanceIncomplete({ reason: "missing" });
  let expiresAt: string | undefined;
  if (input.expiresAt) {
    const parsed = Date.parse(input.expiresAt);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        input.expiresAt,
      ) ||
      !Number.isFinite(parsed)
    )
      return yield* new AcceptanceIncomplete({ reason: "invalid-expiry" });
    if (parsed <= Date.parse(acceptedAt))
      return yield* new AcceptanceIncomplete({ reason: "expiry-in-past" });
    expiresAt = new Date(parsed).toISOString();
  }
  const review = yield* securityReviewFromStateEffect(state, query);
  if (!review.audit.findings.some((finding) => finding.fingerprint === input.fingerprint))
    return yield* new SecurityFindingAbsent({ fingerprint: input.fingerprint });
  const acceptance: SkillAssessmentAcceptance = {
    fingerprint: input.fingerprint,
    artifactContentDigest: review.artifactContentDigest,
    skill_version_id: review.skill_version_id,
    context: "project",
    principal: input.principal.trim(),
    rationale: input.rationale.trim(),
    acceptedAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
  const next = {
    ...state,
    assessmentAcceptances: [...(state.assessmentAcceptances ?? []), acceptance],
  };
  yield* (yield* LibraryStore).publish(next);
  return yield* securityReviewFromStateEffect(next, review.skill_version_id);
});
