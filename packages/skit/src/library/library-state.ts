import { Effect, Schema, Struct } from "effect";
import { isAbsolute, resolve } from "node:path";
import { ProjectionId, SkillId, SkillVersionId } from "./entity-ids.js";
import {
  Acquisition,
  Binding,
  BindingEntry,
  Collection,
  currentLibraryManifest,
  LibraryManifest,
  RetainedCopy,
  Skill,
  librarySnapshotDigests,
} from "./library-contracts.js";
import {
  Digest,
  HarnessInstallStatus,
  InvocationPolicy,
  LibraryDeviceStateFields,
  RecordedProjectionTarget,
} from "./store/state-schema.js";

export const AbsoluteDevicePath = Schema.String.check(
  Schema.makeFilter(isAbsolute, { message: "Expected an absolute device path" }),
);
export type AbsoluteDevicePath = typeof AbsoluteDevicePath.Type;

export const DeviceBinding = Schema.Struct({
  ...Binding.fields,
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
export interface DeviceBinding extends Schema.Schema.Type<typeof DeviceBinding> {}

export const RepositoryBinding = Schema.Struct({
  scope: Schema.Struct({ kind: Schema.Literal("repository"), root: AbsoluteDevicePath }),
  entries: Schema.Array(BindingEntry),
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
export interface RepositoryBinding extends Schema.Schema.Type<typeof RepositoryBinding> {}

export const ManagedProjection = Schema.Struct({
  projection_id: ProjectionId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  target: RecordedProjectionTarget,
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

/**
 * The portable Library this state was last reconciled with. It lives in the same document as the
 * state it describes so that no write, crash, or restore can pair state with a newer base.
 */
export const SyncAncestry = Schema.Struct({
  origin: Schema.NonEmptyString,
  library_id: Schema.NonEmptyString,
  revision_id: Schema.NonEmptyString,
  base_manifest: LibraryManifest,
});
export interface SyncAncestry extends Schema.Schema.Type<typeof SyncAncestry> {}

export const CURRENT_LIBRARY_STATE_VERSION = 8 as const;

export const LibraryState = Schema.Struct({
  ...LibraryDeviceStateFields,
  schemaVersion: Schema.Literal(CURRENT_LIBRARY_STATE_VERSION),
  sync_ancestry: Schema.optionalKey(SyncAncestry),
  collections: Schema.mutable(Schema.Array(Collection)),
  skills: Schema.mutable(Schema.Array(Skill)),
  retained_copies: Schema.mutable(Schema.Array(RetainedCopy)),
  acquisitions: Schema.mutable(Schema.Array(Acquisition)),
  global_bindings: Schema.mutable(Schema.Array(DeviceBinding)),
  local_bindings: Schema.mutable(Schema.Array(RepositoryBinding)),
  projections: Schema.mutable(Schema.Array(ManagedProjection)),
}).check(
  Schema.makeFilter(
    (state) => {
      const skills = new Map(state.skills.map((skill) => [skill.skill_id, skill]));
      const collections = new Set(state.collections.map((collection) => collection.collection_id));
      const localCoordinates = state.local_bindings.map((binding) => resolve(binding.scope.root));
      const projectionCoordinates = state.projections.map((projection) => resolve(projection.path));
      return (
        state.global_bindings.length <= 1 &&
        new Set(localCoordinates).size === localCoordinates.length &&
        new Set(projectionCoordinates).size === projectionCoordinates.length &&
        new Set(state.projections.map((projection) => projection.projection_id)).size ===
          state.projections.length &&
        state.local_bindings.every((binding) =>
          binding.entries.every((entry) =>
            entry.kind === "skill"
              ? skills.has(entry.skill_id)
              : collections.has(entry.collection_id),
          ),
        ) &&
        state.projections.every((projection) => {
          const skill = skills.get(projection.skill_id);
          return skill?.versions.some(
            (version) => version.skill_version_id === projection.skill_version_id,
          );
        })
      );
    },
    { message: "Device Bindings and Projections must name retained entities" },
  ),
);
export interface LibraryState extends Schema.Schema.Type<typeof LibraryState> {}

export const currentLibraryState = (fields: Omit<LibraryState, "schemaVersion">): LibraryState => ({
  ...fields,
  schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
});

export const LibraryInventory = LibraryState.mapFields(
  Struct.omit([
    "schemaVersion",
    "assessmentAcceptances",
    "sync_ancestry",
    "collections",
    "retained_copies",
    "acquisitions",
    "global_bindings",
    "local_bindings",
  ]),
);
export type LibraryInventory = typeof LibraryInventory.Type;

export const decodeLibraryState = Schema.decodeUnknownEffect(LibraryState, {
  onExcessProperty: "preserve",
});
export const encodeLibraryState = Schema.encodeUnknownEffect(LibraryState, {
  onExcessProperty: "preserve",
});

export const libraryManifestFromLocalStateEffect = Effect.fn(
  "Library.libraryManifestFromLocalState",
)(function* (state: LibraryState) {
  const snapshot_digests = librarySnapshotDigests(state);
  return yield* LibraryManifest.makeEffect(
    currentLibraryManifest({
      collections: state.collections,
      skills: state.skills,
      retained_copies: state.retained_copies,
      acquisitions: state.acquisitions,
      snapshot_digests,
      bindings: state.global_bindings.map(
        ({ invocation_policies: _policies, ...binding }) => binding,
      ),
    }),
  );
});

export const collectionSkills = (state: Pick<LibraryState, "skills">, collection: Collection) =>
  state.skills.filter((skill) => skill.collection_id === collection.collection_id);
