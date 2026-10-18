import { Effect } from "effect";
import type { BindingEntry, DeviceSkillSelection, LibraryManifest } from "@smolai/skit-core";
import { OptionCombinationInvalid } from "../failures.js";

/** Resolve explicit names once to stable identities; collection entries continue to follow membership. */
export const selectDeviceSkills = Effect.fn("Library.selectDeviceSkills")(function* (
  manifest: LibraryManifest,
  request: { readonly skills: readonly string[]; readonly collections: readonly string[] },
) {
  const entries: BindingEntry[] = [];
  for (const query of request.skills) {
    const matches = manifest.skills.filter(
      (skill) => skill.name === query || skill.skill_id === query,
    );
    if (matches.length !== 1)
      return yield* new OptionCombinationInvalid({
        detail: `Device Skill ${query} matched ${matches.length} Skills; use a unique name or Skill ID.`,
      });
    entries.push({ kind: "skill", skill_id: matches[0]!.skill_id });
  }
  for (const query of request.collections) {
    const matches = manifest.collections.filter(
      (collection) => collection.label === query || collection.collection_id === query,
    );
    if (matches.length !== 1)
      return yield* new OptionCombinationInvalid({
        detail: `Device Collection ${query} matched ${matches.length} Collections; use a unique label or Collection ID.`,
      });
    entries.push({ kind: "collection", collection_id: matches[0]!.collection_id });
  }
  const unique = [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()];
  return {
    mode: "choose",
    binding: { scope: { kind: "global" }, entries: unique },
  } satisfies DeviceSkillSelection;
});
