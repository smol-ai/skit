import type { Hash } from "../vocabulary.js";
import type {
  InstalledSkill,
  InstalledSkillConflicted,
  InstalledSkillInstalled,
  InstalledSkillPending,
  InstalledSkillSuppressed,
} from "./library-state.js";

// The only places an installed copy's status changes. Each takes the statuses it may leave and
// keeps only the fields its new status uses.

const recorded = ({
  installed_skill_id,
  skill_id,
  skill_version_id,
  destination,
  root,
  path,
  expected_hash,
  installed_at,
}: InstalledSkill) => ({
  installed_skill_id,
  skill_id,
  skill_version_id,
  destination,
  root,
  path,
  expected_hash,
  installed_at,
});

/** Its folder is exactly what SKIT wrote, `expected_hash` unless SKIT now expects another. */
export const installed = (
  copy: InstalledSkill,
  expected_hash: Hash = copy.expected_hash,
): InstalledSkillInstalled => ({ ...recorded(copy), expected_hash, status: "installed" });

/** SKIT moved its folder to recovery, or has not written it yet. */
export const pending = (copy: InstalledSkill): InstalledSkillPending => ({
  ...recorded(copy),
  status: "pending",
});

/** Its folder holds `current_hash`, which SKIT did not write. */
export const conflicted = (
  copy: InstalledSkill,
  current_hash: Hash,
  expected_hash: Hash = copy.expected_hash,
): InstalledSkillConflicted => ({
  ...recorded(copy),
  expected_hash,
  status: "conflicted",
  current_hash,
});

/** The user deleted its folder at `suppressed_at`, or earlier when that time is unknown. */
export const suppressed = (
  copy: InstalledSkill,
  suppressed_at: string | undefined,
): InstalledSkillSuppressed => ({
  ...recorded(copy),
  status: "suppressed",
  suppression_reason: "native_delete",
  ...(suppressed_at === undefined ? {} : { suppressed_at }),
});
