import { Schema } from "effect";
import {
  AcquisitionV4,
  BindingV4,
  CollectionV4,
  RetainedCopyV4,
  SkillV4,
  migrateLibraryEntitiesFromV4,
} from "../library-contracts-v4.js";
import { AbsoluteDevicePath, currentLibraryState, type LibraryState } from "../library-state.js";
import {
  AdoptionReceiptId,
  CollectionId,
  MachineId,
  ProjectionId,
  SkillId,
  SkillVersionId,
} from "../entity-ids.js";
import {
  Digest,
  HarnessInstallStatus,
  HarnessName,
  InvocationPolicy,
  LibraryDeviceStateFields,
} from "./state-schema.js";

const SkillAssessmentAcceptanceV4 = Schema.Struct({
  fingerprint: Digest,
  artifactContentDigest: Digest,
  skillRef: SkillVersionId,
  context: Schema.Literal("project"),
  principal: Schema.String,
  rationale: Schema.String,
  acceptedAt: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
});

const DeviceBindingV4 = Schema.Struct({
  ...BindingV4.fields,
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
const RepositoryBindingV4 = Schema.Struct({
  collection_id: CollectionId,
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("repository"), root: AbsoluteDevicePath }),
  skills: Schema.Array(SkillId),
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
const ManagedProjectionV4 = Schema.Struct({
  projection_id: ProjectionId,
  collection_id: CollectionId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  harness: HarnessName,
  root: AbsoluteDevicePath,
  path: AbsoluteDevicePath,
  expected_digest: Digest,
  observed_digest: Schema.mutableKey(Schema.optional(Digest)),
  status: Schema.mutableKey(HarnessInstallStatus),
  suppression_reason: Schema.mutableKey(Schema.optional(Schema.Literal("native_delete"))),
  suppressed_at: Schema.mutableKey(Schema.optional(Schema.String)),
  projected_at: Schema.String,
});
const AdoptionReceiptV4 = Schema.Struct({
  receipt_id: AdoptionReceiptId,
  adopted_at: Schema.String,
  machine_id: MachineId,
  path: AbsoluteDevicePath,
  observed_digest: Digest,
  skill_version_id: SkillVersionId,
  projection_ids: Schema.Array(ProjectionId),
});

export const LibraryStateV4 = Schema.Struct({
  ...LibraryDeviceStateFields,
  assessmentAcceptances: Schema.mutableKey(
    Schema.optional(Schema.mutable(Schema.Array(SkillAssessmentAcceptanceV4))),
  ),
  schemaVersion: Schema.Literal(4),
  collections: Schema.mutable(Schema.Array(CollectionV4)),
  skills: Schema.mutable(Schema.Array(SkillV4)),
  retained_copies: Schema.mutable(Schema.Array(RetainedCopyV4)),
  acquisitions: Schema.mutable(Schema.Array(AcquisitionV4)),
  global_bindings: Schema.mutable(Schema.Array(DeviceBindingV4)),
  local_bindings: Schema.mutable(Schema.Array(RepositoryBindingV4)),
  projections: Schema.mutable(Schema.Array(ManagedProjectionV4)),
  adoption_receipts: Schema.mutable(Schema.Array(AdoptionReceiptV4)),
});
export type LibraryStateV4 = typeof LibraryStateV4.Type;

export const migrateLibraryStateFromV4 = (state: LibraryStateV4): LibraryState => {
  const migrated = migrateLibraryEntitiesFromV4({
    collections: state.collections,
    skills: state.skills,
    acquisitions: state.acquisitions,
    bindings: state.global_bindings,
  });
  const {
    schemaVersion: _legacyVersion,
    adoption_receipts: _legacyReceipts,
    collections: _legacyCollections,
    skills: _legacySkills,
    acquisitions: _legacyAcquisitions,
    global_bindings: _legacyGlobalBindings,
    local_bindings,
    projections,
    assessmentAcceptances,
    ...fields
  } = state;
  const localByCoordinate = new Map<string, LibraryState["local_bindings"][number]>();
  for (const binding of local_bindings) {
    const key = `${binding.harness}\0${binding.scope.root}`;
    const prior = localByCoordinate.get(key);
    localByCoordinate.set(key, {
      harness: binding.harness,
      scope: binding.scope,
      skills: [...new Set([...(prior?.skills ?? []), ...binding.skills])],
      ...(binding.invocation_policies === undefined && prior?.invocation_policies === undefined
        ? {}
        : {
            invocation_policies: {
              ...(prior?.invocation_policies ?? {}),
              ...(binding.invocation_policies ?? {}),
            },
          }),
    });
  }
  return currentLibraryState({
    ...fields,
    ...(assessmentAcceptances === undefined
      ? {}
      : {
          assessmentAcceptances: assessmentAcceptances.map(({ skillRef, ...acceptance }) => ({
            ...acceptance,
            skill_version_id: skillRef,
          })),
        }),
    retained_copies: state.retained_copies.map(
      ({ v3_normalized_tree: _legacyNormalizedTree, ...copy }) => copy,
    ),
    collections: migrated.collections,
    skills: migrated.skills,
    acquisitions: migrated.acquisitions,
    global_bindings: migrated.bindings.map((binding) => {
      const legacyPolicies = state.global_bindings
        .filter((candidate) => candidate.harness === binding.harness)
        .reduce<Record<string, InvocationPolicy>>(
          (all, candidate) => ({ ...all, ...(candidate.invocation_policies ?? {}) }),
          {},
        );
      return {
        ...binding,
        ...(Object.keys(legacyPolicies).length === 0
          ? {}
          : { invocation_policies: legacyPolicies }),
      };
    }),
    local_bindings: [...localByCoordinate.values()],
    projections: projections.map(({ collection_id: _collectionId, ...projection }) => projection),
  });
};
