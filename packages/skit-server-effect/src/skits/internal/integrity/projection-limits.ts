import {
  MAX_PROJECTED_RELEASE_BYTES,
  MAX_PROJECTED_RELEASE_ENTRIES,
  MAX_PROJECTED_SKILL_BYTES,
  MAX_PROJECTED_SKILL_ENTRIES,
} from "@smolai/skit-core/universal/authoring";
import { measureSkillProjection, projectionIndex } from "@smolai/skit-core/universal/consumer";

/**
 * The first Skill whose served archive would break a projection limit, measured before any
 * projection is built. Publication and discovery apply the same limits, so a Release published
 * before them is refused rather than built.
 */
export const projectionLimitExceeded = (
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  skills: ReadonlyArray<{ path: string; shared?: ReadonlyArray<{ from: string; to: string }> }>,
):
  | { code: "PROJECTED_SKILL_TOO_LARGE" | "PROJECTED_RELEASE_TOO_LARGE"; path: string }
  | undefined => {
  const index = projectionIndex(files);
  const release = { entries: 0, archiveBytes: 0 };
  for (const skill of skills) {
    const measured = measureSkillProjection(index, skill.path, skill.shared ?? [], {
      entries: Math.min(
        MAX_PROJECTED_SKILL_ENTRIES,
        MAX_PROJECTED_RELEASE_ENTRIES - release.entries,
      ),
      archiveBytes: Math.min(
        MAX_PROJECTED_SKILL_BYTES,
        MAX_PROJECTED_RELEASE_BYTES - release.archiveBytes,
      ),
    });
    if (
      measured.entries > MAX_PROJECTED_SKILL_ENTRIES ||
      measured.archiveBytes > MAX_PROJECTED_SKILL_BYTES
    )
      return { code: "PROJECTED_SKILL_TOO_LARGE", path: skill.path };
    release.entries += measured.entries;
    release.archiveBytes += measured.archiveBytes;
    if (
      release.entries > MAX_PROJECTED_RELEASE_ENTRIES ||
      release.archiveBytes > MAX_PROJECTED_RELEASE_BYTES
    )
      return { code: "PROJECTED_RELEASE_TOO_LARGE", path: skill.path };
  }
  return undefined;
};
