import { ManifestViolation } from "@smolai/skit-core/library/manifest-violation";

const collection = ({
  label,
  collectionId,
}: {
  readonly label: string;
  readonly collectionId: string;
}) => `Collection ${label} (${collectionId})`;
const skill = ({ name, skillId }: { readonly name: string; readonly skillId: string }) =>
  `Skill ${name} (${skillId})`;

export const manifestViolation = (violation: ManifestViolation): string =>
  ManifestViolation.match(violation, {
    DuplicateIdentifiers: ({ entity, ids }) =>
      `${{ collections: "Collections", skills: "Skills", collection_versions: "Collection Versions", imports: "Imports", versions: "Versions" }[entity]} contain duplicate IDs: ${ids.join(", ")}`,
    DuplicateSkillPaths: (v) =>
      `${collection(v)} contains duplicate Skill paths: ${v.paths.join(", ")}`,
    DuplicateSkillNames: (v) =>
      `${collection(v)} contains duplicate current Skill names: ${v.names.join(", ")}`,
    OverlappingSkillPaths: (v) =>
      `${collection(v)} contains overlapping Skill paths: ${v.left} and ${v.right}`,
    RootSkillWithChildren: (v) =>
      `${collection(v)} mixes a root Skill with child Skills: ${v.paths.join(", ")}`,
    DuplicateUpstream: ({ first, second }) =>
      `${collection(first)} and ${collection(second)} use the same upstream`,
    ImportCollectionMissing: ({ importId, collectionId }) =>
      `Import ${importId} references missing Collection ${collectionId}`,
    ImportCopyMissing: ({ importId, copyId }) =>
      `Import ${importId} references missing Collection Version ${copyId}`,
    CopyMembersEmpty: ({ copyId }) => `Collection Version ${copyId} has no members`,
    CopyMemberPathsDuplicate: ({ copyId, paths }) =>
      `Collection Version ${copyId} contains duplicate member paths: ${paths.join(", ")}`,
    CopyImportMissing: ({ copyId }) => `Collection Version ${copyId} has no owning import`,
    SkillCollectionMissing: (v) => `${skill(v)} references missing Collection ${v.collectionId}`,
    SkillVersionMissing: (v) => `${skill(v)} selects missing Version ${v.versionId}`,
    ArtifactVersionsDuplicate: (v) =>
      `${skill(v)} contains more than one Version for ${v.hash}: ${v.versionIds.join(", ")}`,
    VersionBackingMissing: (v) => `${skill(v)} Version ${v.versionId} has no stored Import backing`,
    CollectionVersionHashesDuplicate: ({ digests }) =>
      `Collection Version hashes contain duplicates: ${[...new Set(digests)].join(", ")}`,
    CollectionVersionHashesMismatch: ({ expected, actual }) =>
      `Collection Version hashes do not match required stored Versions; expected ${expected.join(", ") || "none"}, found ${actual.join(", ") || "none"}`,
    EnabledDuplicate: ({ kind, id }) => `The enabled list repeats ${kind} ${id}`,
    EnabledSubjectMissing: ({ kind, id }) => `The enabled list names missing ${kind} ${id}`,
  });
