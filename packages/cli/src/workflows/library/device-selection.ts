import { Effect } from "effect";
import type { DeviceSkillSelection, Enabled, LibraryManifest } from "@smolai/skit-core";
import { OptionCombinationInvalid } from "../failures.js";

/** Resolve explicit names once to stable identities; collection items continue to follow membership. */
export const selectDeviceSkills = Effect.fn("Library.selectDeviceSkills")(function* (
  manifest: LibraryManifest,
  request: { readonly skills: readonly string[]; readonly collections: readonly string[] },
) {
  const items: Enabled[] = [];
  for (const query of request.skills) {
    const matches = manifest.skills.filter(
      (skill) => skill.name === query || skill.skill_id === query,
    );
    if (matches.length !== 1)
      return yield* new OptionCombinationInvalid({
        detail: `Device Skill ${query} matched ${matches.length} Skills; use a unique name or Skill ID.`,
      });
    items.push({ skill: matches[0]!.skill_id });
  }
  for (const query of request.collections) {
    const matches = manifest.collections.filter(
      (collection) => collection.label === query || collection.collection_id === query,
    );
    if (matches.length !== 1)
      return yield* new OptionCombinationInvalid({
        detail: `Device Collection ${query} matched ${matches.length} Collections; use a unique label or Collection ID.`,
      });
    items.push({ collection: matches[0]!.collection_id });
  }
  const unique = [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];
  return { mode: "choose", enabled: unique } satisfies DeviceSkillSelection;
});
