import type { SkillsShProvenanceObservation } from "./store/state-schema.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/json.js";
import type { PortableSkillsShObservation } from "./portable-contracts.js";

export const sanitizePortableClaim = (claim: string) => {
  const url = URL.parse(claim);
  if (url === null || (url.username === "" && url.password === "")) return claim;
  return claim.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
};
const safeRelative = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** Lock claims travel without custody or inferred Source verification. */
export const portableEvidenceFromObservations = (
  observations: readonly SkillsShProvenanceObservation[],
  name: string,
) => {
  const records = observations
    .filter((observation) => observation.skillName === name)
    .flatMap((observation) => {
      const claims = [
        ["computed", observation.computedHash],
        ["folder", observation.skillFolderHash],
        ["well-known", observation.wellKnownDigest],
      ] as const;
      return claims.flatMap(([hash_kind, hash_digest]) =>
        hash_digest === undefined
          ? []
          : [
              {
                kind: "skills.sh-lock" as const,
                claimed_source: sanitizePortableClaim(observation.source),
                ...(observation.ref === undefined
                  ? {}
                  : { ref: sanitizePortableClaim(observation.ref) }),
                ...(observation.skillPath === undefined || !safeRelative(observation.skillPath)
                  ? {}
                  : { selected_skill_path: observation.skillPath }),
                hash_kind,
                hash_digest,
                retained_byte_agreement: observation.contentAgreement,
              },
            ],
      );
    });
  return [...new Map(records.map((record) => [JSON.stringify(record), record])).values()];
};

export const portableObservations = (
  observations: readonly SkillsShProvenanceObservation[],
  machineId?: PortableSkillsShObservation["machine_id"],
): PortableSkillsShObservation[] =>
  observations.map((observation) => ({
    type: "skills.sh-lock",
    machine_id:
      machineId ?? (observation.machineId as unknown as PortableSkillsShObservation["machine_id"]),
    observed_at: observation.observedAt,
    ...(observation.sourceUpdatedAt === undefined
      ? {}
      : { source_updated_at: observation.sourceUpdatedAt }),
    lock_path: { value: observation.lockPath },
    lock_version: observation.lockVersion,
    lock_scope: observation.lockScope,
    lock_content_hash: observation.lockContentHash,
    source: sanitizePortableClaim(observation.source),
    source_type: observation.sourceType,
    ...(observation.sourceUrl === undefined
      ? {}
      : { source_url: sanitizePortableClaim(observation.sourceUrl) }),
    ...(observation.sourceBaseUrl === undefined
      ? {}
      : { source_base_url: sanitizePortableClaim(observation.sourceBaseUrl) }),
    ...(observation.ref === undefined ? {} : { ref: sanitizePortableClaim(observation.ref) }),
    skill_name: observation.skillName,
    ...(observation.skillPath === undefined || !safeRelative(observation.skillPath)
      ? {}
      : { skill_path: observation.skillPath }),
    ...(observation.computedHash === undefined ? {} : { computed_hash: observation.computedHash }),
    ...(observation.skillFolderHash === undefined
      ? {}
      : { skill_folder_hash: observation.skillFolderHash }),
    ...(observation.wellKnownDigest === undefined
      ? {}
      : { well_known_digest: observation.wellKnownDigest }),
    content_agreement: observation.contentAgreement,
    original_entry_digest: `sha256:${createHash("sha256").update(canonicalJson(observation.originalEntry)).digest("hex")}`,
    original_entry: observation.originalEntry,
  }));
