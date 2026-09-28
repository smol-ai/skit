import { Schema } from "effect";
import { SkillId } from "../entity-ids.js";
import { RetainedCopy } from "../library-contracts.js";
import {
  AcquisitionV5,
  BindingV5,
  CollectionV5,
  migrateLibraryEntitiesFromV5,
  SkillV5,
} from "../library-contracts-v5.js";
import {
  AbsoluteDevicePath,
  currentLibraryState,
  ManagedProjection,
  type LibraryState,
} from "../library-state.js";
import { HarnessName, InvocationPolicy, LibraryDeviceStateFields } from "./state-schema.js";

const DeviceBindingV5 = Schema.Struct({
  ...BindingV5.fields,
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
const RepositoryBindingV5 = Schema.Struct({
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("repository"), root: AbsoluteDevicePath }),
  skills: Schema.Array(SkillId),
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});

export const LibraryStateV5 = Schema.Struct({
  ...LibraryDeviceStateFields,
  schemaVersion: Schema.Literal(5),
  collections: Schema.Array(CollectionV5),
  skills: Schema.Array(SkillV5),
  retained_copies: Schema.Array(RetainedCopy),
  acquisitions: Schema.Array(AcquisitionV5),
  global_bindings: Schema.Array(DeviceBindingV5),
  local_bindings: Schema.Array(RepositoryBindingV5),
  projections: Schema.Array(ManagedProjection),
});
export type LibraryStateV5 = typeof LibraryStateV5.Type;

export const migrateLibraryStateFromV5 = (state: LibraryStateV5): LibraryState => {
  const {
    schemaVersion: _legacyVersion,
    collections: _collections,
    skills: _skills,
    retained_copies: _copies,
    acquisitions: _acquisitions,
    global_bindings,
    local_bindings,
    projections,
    ...fields
  } = state;
  const migrated = migrateLibraryEntitiesFromV5({
    ...state,
    boundSkillIds: new Set(
      [...global_bindings, ...local_bindings].flatMap((binding) => binding.skills),
    ),
    projectedVersions: projections,
  });
  return currentLibraryState({
    ...fields,
    collections: [...migrated.collections],
    skills: [...migrated.skills],
    retained_copies: [...migrated.retained_copies],
    acquisitions: [...migrated.acquisitions],
    global_bindings: global_bindings.map(({ skills, ...binding }) => ({
      ...binding,
      entries: migrated.entries(skills),
    })),
    local_bindings: local_bindings.map(({ skills, ...binding }) => ({
      ...binding,
      entries: migrated.entries(skills),
    })),
    projections: projections.filter((projection) =>
      migrated.skills.some((skill) => skill.skill_id === projection.skill_id),
    ),
  });
};
