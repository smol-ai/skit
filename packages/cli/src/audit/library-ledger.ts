import { isJsonObject, objectAt, SkillId, stringAt } from "@smolai/skit-core";
import { Schema } from "effect";

const decodedSkillId = (value: unknown): string | undefined => {
  const decoded = Schema.decodeUnknownOption(SkillId)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

export function retainedLibraryReferences(value: unknown): Set<string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const legacyRecords = [
    ...(Array.isArray(value.entries) ? value.entries : []),
    ...(Array.isArray(value.installations) ? value.installations : []),
  ];
  const collectionRefs = (Array.isArray(value.collections) ? value.collections : []).flatMap(
    (collection) => {
      if (!isJsonObject(collection)) return [];
      const localEntry = objectAt(collection, "local_entry");
      return [
        localEntry && stringAt(localEntry, "collection_ref"),
        stringAt(collection, "collection_id"),
      ].filter((candidate): candidate is string => typeof candidate === "string");
    },
  );
  const projectionRefs = (Array.isArray(value.projections) ? value.projections : []).flatMap(
    (projection) => {
      if (!isJsonObject(projection)) return [];
      return [
        decodedSkillId(projection.skill_id),
        stringAt(projection, "collection_id"),
        stringAt(projection, "marker_collection_ref"),
      ].filter((candidate): candidate is string => typeof candidate === "string");
    },
  );
  const skillRefs = (Array.isArray(value.skills) ? value.skills : []).flatMap((skill) => {
    if (!isJsonObject(skill)) return [];
    const skillId = decodedSkillId(skill.skill_id);
    return skillId === undefined ? [] : [skillId];
  });
  return new Set(
    legacyRecords
      .flatMap((record) =>
        isJsonObject(record) && typeof record.collectionRef === "string"
          ? [record.collectionRef]
          : [],
      )
      .concat(collectionRefs, projectionRefs, skillRefs),
  );
}
