import { Schema, SchemaIssue } from "effect";
import { Hash } from "../shared/hash.js";

const collection = { collectionId: Schema.String, label: Schema.String };
const skill = { skillId: Schema.String, name: Schema.String };
const reference = { kind: Schema.Literals(["skill", "collection"]), id: Schema.String };

/** Relational constraints checked after the manifest's individual fields decode. */
export const ManifestViolation = Schema.TaggedUnion({
  DuplicateIdentifiers: {
    entity: Schema.Literals([
      "collections",
      "skills",
      "collection_versions",
      "imports",
      "versions",
    ]),
    ids: Schema.Array(Schema.String),
  },
  DuplicateSkillPaths: { ...collection, paths: Schema.Array(Schema.String) },
  DuplicateSkillNames: { ...collection, names: Schema.Array(Schema.String) },
  OverlappingSkillPaths: { ...collection, left: Schema.String, right: Schema.String },
  RootSkillWithChildren: { ...collection, paths: Schema.Array(Schema.String) },
  DuplicateUpstream: { first: Schema.Struct(collection), second: Schema.Struct(collection) },
  ImportCollectionMissing: { importId: Schema.String, collectionId: Schema.String },
  ImportCopyMissing: { importId: Schema.String, copyId: Schema.String },
  CopyMembersEmpty: { copyId: Schema.String },
  CopyMemberPathsDuplicate: { copyId: Schema.String, paths: Schema.Array(Schema.String) },
  CopyImportMissing: { copyId: Schema.String },
  SkillCollectionMissing: { ...skill, collectionId: Schema.String },
  SkillVersionMissing: { ...skill, versionId: Schema.String },
  ArtifactVersionsDuplicate: { ...skill, hash: Hash, versionIds: Schema.Array(Schema.String) },
  VersionBackingMissing: { ...skill, versionId: Schema.String },
  CollectionVersionHashesDuplicate: { digests: Schema.Array(Hash) },
  CollectionVersionHashesMismatch: { expected: Schema.Array(Hash), actual: Schema.Array(Hash) },
  EnabledDuplicate: reference,
  EnabledSubjectMissing: reference,
});
export type ManifestViolation = typeof ManifestViolation.Type;

/** A native Schema issue carries the domain fact, without rendering it or serializing live errors. */
export const manifestViolationIssue = (
  path: readonly PropertyKey[],
  violation: ManifestViolation,
): Schema.FilterIssue => ({
  path,
  issue: new SchemaIssue.Filter(
    Schema.makeFilter(() => false, {
      representation: { id: "skit/schema/library-manifest", payload: violation },
    }),
    new SchemaIssue.InvalidValue(),
  ),
});
