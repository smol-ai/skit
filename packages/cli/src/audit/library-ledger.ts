import { isJsonObject, SkillId } from "@smolai/skit-core";
import { Schema } from "effect";

const decodedSkillId = (value: unknown): string | undefined => {
  const decoded = Schema.decodeUnknownOption(SkillId)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

export function retainedLibraryReferences(value: unknown): Set<string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const skillIds = (Array.isArray(value.skills) ? value.skills : []).flatMap((skill) => {
    if (!isJsonObject(skill)) return [];
    const skillId = decodedSkillId(skill.skill_id);
    return skillId === undefined ? [] : [skillId];
  });
  return new Set(skillIds);
}
