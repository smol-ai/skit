import { Schema, SchemaGetter } from "effect";
import { Hash } from "../shared/hash.js";
import { HarnessName } from "../harnesses/contracts.js";
import { CollectionId, InstalledSkillId, SkillId, SkillVersionId } from "../library/entity-ids.js";
import { OwnershipMarker } from "./ownership-marker.js";
const OwnershipMarkerV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  projectionPolicyVersion: Schema.Literal(1),
  projection_id: InstalledSkillId,
  collection_id: CollectionId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  expected_digest: Hash,
  harness: HarnessName,
});

const OwnershipMarkerV3 = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  projectionPolicyVersion: Schema.Literal(1),
  projection_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  expected_digest: Hash,
  harness: HarnessName,
});

const OwnershipMarkerV4 = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  projectionPolicyVersion: Schema.Literal(1),
  projection_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  expected_digest: Hash,
});

// v4 named the installed skill a projection, called its hash a digest and carried a policy
// version that was always 1.
const OwnershipMarkerFromV4 = OwnershipMarkerV4.pipe(
  Schema.decodeTo(OwnershipMarker, {
    decode: SchemaGetter.transform(
      ({ projection_id, projectionPolicyVersion: _policy, expected_digest, ...marker }) => ({
        ...marker,
        schemaVersion: 5 as const,
        installed_skill_id: projection_id,
        expected_hash: expected_digest,
      }),
    ),
    encode: SchemaGetter.forbidden(() => "v4 ownership markers are decode-only"),
  }),
);
// Older markers named the Harness a copy was written for; ownership never depended on it.
const OwnershipMarkerFromV3 = OwnershipMarkerV3.pipe(
  Schema.decodeTo(OwnershipMarkerFromV4, {
    decode: SchemaGetter.transform(({ harness: _harness, ...marker }) => ({
      ...marker,
      schemaVersion: 4 as const,
    })),
    encode: SchemaGetter.forbidden(() => "v3 ownership markers are decode-only"),
  }),
);
const OwnershipMarkerFromV2 = OwnershipMarkerV2.pipe(
  Schema.decodeTo(OwnershipMarkerFromV3, {
    decode: SchemaGetter.transform(({ collection_id: _collectionId, ...marker }) => ({
      ...marker,
      schemaVersion: 3 as const,
    })),
    encode: SchemaGetter.forbidden(() => "v2 ownership markers are decode-only"),
  }),
);

/**
 * A marker as written by any SKIT since v2, brought to the current one through the linear
 * v2 → v3 → v4 → v5 chain. Markers live in installed skills, outside versioned Library state, so every
 * released version stays readable.
 */
export const StoredOwnershipMarker = Schema.Union([
  OwnershipMarker,
  OwnershipMarkerFromV4,
  OwnershipMarkerFromV3,
  OwnershipMarkerFromV2,
]);
