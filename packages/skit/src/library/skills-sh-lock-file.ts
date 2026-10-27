import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/json.js";
import type { SkillsShLockFileEntry } from "./library-contracts.js";

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

/** The fields a reader supplies; the constructor derives and checks the rest. */
type SkillsShLockFileFields = Omit<
  SkillsShLockFileEntry,
  "type" | "lock_path" | "skill_path" | "original_entry_digest" | "upstream_baseline"
> & { readonly lock_path: string; readonly skill_path?: string };

/**
 * One skill's entry in a skills.sh lock file, as the Library saves it. Credentials are stripped
 * from every source claim, an unsafe skill path is dropped, and the original entry is hashed.
 */
export const skillsShLockFileEntry = (fields: SkillsShLockFileFields): SkillsShLockFileEntry => {
  const { lock_path, skill_path, source_url, source_base_url, ref, ...rest } = fields;
  return {
    ...rest,
    type: "skills.sh-lock",
    lock_path: { value: lock_path },
    source: sanitizeSourceClaim(fields.source),
    ...(source_url === undefined ? {} : { source_url: sanitizeSourceClaim(source_url) }),
    ...(source_base_url === undefined
      ? {}
      : { source_base_url: sanitizeSourceClaim(source_base_url) }),
    ...(ref === undefined ? {} : { ref: sanitizeSourceClaim(ref) }),
    ...(skill_path === undefined || !safeRelative(skill_path) ? {} : { skill_path }),
    original_entry_digest: `sha256:${createHash("sha256").update(canonicalJson(fields.original_entry)).digest("hex")}`,
  };
};
