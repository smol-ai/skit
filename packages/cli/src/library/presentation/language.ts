import type {
  InstalledSkillConflict,
  OwnershipMarkerInvalidReason,
} from "@smolai/skit-core/library/inventory";

export function ownershipMarkerInvalidReason(reason: OwnershipMarkerInvalidReason): string {
  switch (reason._tag) {
    case "NotObject":
      return "The ownership marker must contain a JSON object.";
    case "InvalidJson":
      return "The ownership marker is not valid JSON.";
    case "InvalidFields":
      return "The ownership marker's fields do not match a supported SKIT format.";
  }
}

/** Human-facing language for stable machine codes. Never fall back to displaying the code. */
const conditionHeadlines: Readonly<Record<string, string>> = {
  DANGLING_SYMLINK: "Dangling symlink",
  INVALID_OWNERSHIP_MARKER: "Invalid SKIT ownership marker",
  MISSING_ROOT: "Harness skills directory is absent",
  ORPHANED_OWNERSHIP_MARKER: "SKIT-managed folder is missing from the Library",
  PROJECTION_CONFLICT: "Local skill copy conflicts with the Library",
  PROJECTION_DRIFT: "Local skill copy differs from the Library",
  UNREADABLE_PATH: "Harness skills directory could not be read",
};

export function conditionHeadline(code: string, fallback: string): string {
  return conditionHeadlines[code] ?? fallback;
}

/** The installed-skill owner supplies the cause; frontends own the explanation. */
export function installedSkillConflictText(conflict: InstalledSkillConflict): string {
  switch (conflict._tag) {
    case "MarkerMissing":
      return "The installed folder has no SKIT ownership marker.";
    case "MarkerInvalid":
      return ownershipMarkerInvalidReason(conflict.reason);
    case "SkillMismatch":
      return "The ownership marker names a different skill.";
    case "InstalledSkillMismatch":
      return conflict.expected === undefined
        ? "The ownership marker belongs to an installed copy that is not recorded here."
        : "The ownership marker belongs to a different installed copy.";
    case "MarkerHashMismatch":
      return "The ownership marker's content hash differs from the Library's record.";
    case "ContentChanged":
      return conflict.baseline === "marker"
        ? "The installed files differ from the content recorded in the ownership marker."
        : "The installed files differ from the content recorded in the Library.";
  }
}

export function conditionNextStep(
  code: string,
  conflicts?: readonly InstalledSkillConflict[],
): string | undefined {
  if (code !== "PROJECTION_CONFLICT") return undefined;
  if (!conflicts?.length)
    return "Run `skit inventory`, then `skit doctor` to check the folder again.";
  if (conflicts.every((conflict) => conflict._tag === "ContentChanged"))
    return "Review the installed files and save any edits you want to keep before replacing this copy.";
  return "Check the folder and its ownership marker before changing it. SKIT cannot safely update this copy.";
}
