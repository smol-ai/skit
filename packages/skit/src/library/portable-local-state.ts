import { Effect, Schema, Struct } from "effect";
import { isAbsolute, resolve } from "node:path";
import {
  AdoptionReceiptId,
  CollectionId,
  MachineId,
  ProjectionId,
  SkillId,
  SkillVersionId,
} from "./entity-ids.js";
import {
  PortableAcquisition,
  PortableBinding,
  PortableCollection,
  PortableLibraryManifest,
  PortableRetainedCopy,
  PortableSkill,
  portableSnapshotDigests,
} from "./portable-contracts.js";
import {
  Digest,
  HarnessInstallStatus,
  HarnessName,
  InvocationPolicy,
  LibraryDeviceStateFields,
} from "./store/state-schema.js";

export const AbsoluteDevicePath = Schema.String.check(
  Schema.makeFilter(isAbsolute, { message: "Expected an absolute device path" }),
);
export type AbsoluteDevicePath = typeof AbsoluteDevicePath.Type;

export const PortableDeviceBinding = Schema.Struct({
  ...PortableBinding.fields,
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
export interface PortableDeviceBinding extends Schema.Schema.Type<typeof PortableDeviceBinding> {}

export const PortableRepositoryBinding = Schema.Struct({
  collection_id: CollectionId,
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("repository"), root: AbsoluteDevicePath }),
  skills: Schema.Array(SkillId),
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
export interface PortableRepositoryBinding extends Schema.Schema.Type<
  typeof PortableRepositoryBinding
> {}

export const ManagedProjection = Schema.Struct({
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
export interface ManagedProjection extends Schema.Schema.Type<typeof ManagedProjection> {}

export const PortableAdoptionReceipt = Schema.Struct({
  receipt_id: AdoptionReceiptId,
  adopted_at: Schema.String,
  machine_id: MachineId,
  path: AbsoluteDevicePath,
  observed_digest: Digest,
  skill_version_id: SkillVersionId,
  projection_ids: Schema.Array(ProjectionId),
});
export type PortableAdoptionReceipt = typeof PortableAdoptionReceipt.Type;

export const LibraryState = Schema.Struct({
  ...LibraryDeviceStateFields,
  schemaVersion: Schema.Literal(4),
  collections: Schema.mutable(Schema.Array(PortableCollection)),
  skills: Schema.mutable(Schema.Array(PortableSkill)),
  retained_copies: Schema.mutable(Schema.Array(PortableRetainedCopy)),
  acquisitions: Schema.mutable(Schema.Array(PortableAcquisition)),
  global_bindings: Schema.mutable(Schema.Array(PortableDeviceBinding)),
  local_bindings: Schema.mutable(Schema.Array(PortableRepositoryBinding)),
  projections: Schema.mutable(Schema.Array(ManagedProjection)),
  adoption_receipts: Schema.mutable(Schema.Array(PortableAdoptionReceipt)),
}).check(
  Schema.makeFilter(
    (state) => {
      const collections = new Map(
        state.collections.map((collection) => [collection.collection_id, collection]),
      );
      const skills = new Map(state.skills.map((skill) => [skill.skill_id, skill]));
      const localCoordinates = state.local_bindings.map(
        (binding) => `${binding.collection_id}\0${binding.harness}\0${resolve(binding.scope.root)}`,
      );
      const projectionCoordinates = state.projections.map(
        (projection) => `${projection.harness}\0${resolve(projection.path)}`,
      );
      return (
        new Set(localCoordinates).size === localCoordinates.length &&
        new Set(projectionCoordinates).size === projectionCoordinates.length &&
        new Set(state.projections.map((projection) => projection.projection_id)).size ===
          state.projections.length &&
        state.local_bindings.every(
          (binding) =>
            collections.has(binding.collection_id) &&
            binding.skills.every(
              (skillId) => skills.get(skillId)?.collection_id === binding.collection_id,
            ),
        ) &&
        state.projections.every((projection) => {
          const skill = skills.get(projection.skill_id);
          return (
            skill?.collection_id === projection.collection_id &&
            skill.versions.some(
              (version) => version.skill_version_id === projection.skill_version_id,
            )
          );
        }) &&
        state.adoption_receipts.every(
          (receipt) =>
            state.skills.some((skill) =>
              skill.versions.some(
                (version) => version.skill_version_id === receipt.skill_version_id,
              ),
            ) &&
            receipt.projection_ids.every((projectionId) =>
              state.projections.some((projection) => projection.projection_id === projectionId),
            ),
        )
      );
    },
    { message: "Device Bindings, Projections, and receipts must name retained entities" },
  ),
);
export interface LibraryState extends Schema.Schema.Type<typeof LibraryState> {}

export const PortableLibraryInventory = LibraryState.mapFields(
  Struct.omit([
    "assessmentAcceptances",
    "collections",
    "retained_copies",
    "acquisitions",
    "global_bindings",
    "local_bindings",
  ]),
);
export type PortableLibraryInventory = typeof PortableLibraryInventory.Type;

export const decodeLibraryState = Schema.decodeUnknownEffect(LibraryState, {
  onExcessProperty: "preserve",
});
export const encodeLibraryState = Schema.encodeUnknownEffect(LibraryState, {
  onExcessProperty: "preserve",
});

export const portableManifestFromLocalStateEffect = Effect.fn(
  "Library.portableManifestFromLocalState",
)(function* (state: LibraryState) {
  const snapshot_digests = portableSnapshotDigests(state);
  return yield* PortableLibraryManifest.makeEffect({
    schema: "skit.library.v4",
    collections: state.collections,
    skills: state.skills,
    retained_copies: state.retained_copies,
    acquisitions: state.acquisitions,
    snapshot_digests,
    bindings: state.global_bindings.map(
      ({ invocation_policies: _policies, ...binding }) => binding,
    ),
  });
});

export const selectedSkillVersion = (skill: PortableSkill) =>
  skill.selected_skill_version_id === undefined
    ? undefined
    : skill.versions.find(
        (version) => version.skill_version_id === skill.selected_skill_version_id,
      );

export const collectionSkills = (
  state: Pick<LibraryState, "skills">,
  collection: PortableCollection,
) => state.skills.filter((skill) => skill.collection_id === collection.collection_id);
