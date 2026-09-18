import { isJsonObject, objectAt, stringAt } from "@smolai/skit-core";

export function retainedLibraryReferences(value: unknown): Set<string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const legacyRecords = [
    ...(Array.isArray(value.entries) ? value.entries : []),
    ...(Array.isArray(value.installations) ? value.installations : []),
  ];
  const portableCollectionRefs = (
    Array.isArray(value.collections) ? value.collections : []
  ).flatMap((collection) => {
    if (!isJsonObject(collection)) return [];
    const localEntry = objectAt(collection, "local_entry");
    return [
      localEntry && stringAt(localEntry, "collection_ref"),
      stringAt(collection, "collection_id"),
    ].filter((candidate): candidate is string => typeof candidate === "string");
  });
  const portableProjectionRefs = (
    Array.isArray(value.projections) ? value.projections : []
  ).flatMap((projection) => {
    if (!isJsonObject(projection)) return [];
    return [
      stringAt(projection, "collection_id"),
      stringAt(projection, "marker_collection_ref"),
    ].filter((candidate): candidate is string => typeof candidate === "string");
  });
  return new Set(
    legacyRecords
      .flatMap((record) =>
        isJsonObject(record) && typeof record.collectionRef === "string"
          ? [record.collectionRef]
          : [],
      )
      .concat(portableCollectionRefs, portableProjectionRefs),
  );
}
