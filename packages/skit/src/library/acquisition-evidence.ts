import type { SkillsShProvenanceObservation } from "./store/state-schema.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/json.js";
import type { SkillsShObservation } from "./library-contracts.js";

export const sanitizeSourceClaim = (claim: string) => {
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

export const acquisitionObservations = (
  observations: readonly SkillsShProvenanceObservation[],
  machineId?: SkillsShObservation["machine_id"],
): SkillsShObservation[] =>
  observations.map((observation) => ({
    type: "skills.sh-lock",
    machine_id:
      machineId ?? (observation.machineId as unknown as SkillsShObservation["machine_id"]),
    observed_at: observation.observedAt,
    ...(observation.sourceUpdatedAt === undefined
      ? {}
      : { source_updated_at: observation.sourceUpdatedAt }),
    lock_path: { value: observation.lockPath },
    lock_version: observation.lockVersion,
    lock_scope: observation.lockScope,
    lock_content_hash: observation.lockContentHash,
    source: sanitizeSourceClaim(observation.source),
    source_type: observation.sourceType,
    ...(observation.sourceUrl === undefined
      ? {}
      : { source_url: sanitizeSourceClaim(observation.sourceUrl) }),
    ...(observation.sourceBaseUrl === undefined
      ? {}
      : { source_base_url: sanitizeSourceClaim(observation.sourceBaseUrl) }),
    ...(observation.ref === undefined ? {} : { ref: sanitizeSourceClaim(observation.ref) }),
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
