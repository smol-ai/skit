import { Schema, SchemaGetter } from "effect";
import { SkillId } from "../entity-ids.js";
import { RetainedCopy } from "../library-contracts.js";
import { AbsoluteDevicePath } from "../library-state.js";
import { HarnessName, InvocationPolicy } from "../../vocabulary.js";
import {
  AcquisitionV5,
  BindingV5,
  CollectionV5,
  migrateLibraryEntitiesFromV5,
  SkillV5,
} from "./manifest-v5.js";
import { LibraryDeviceStateFields } from "./state-schema.js";
import { LibraryStateFromV6, LibraryStateV6 } from "./state-schema-v6.js";

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
  projections: LibraryStateV6.fields.projections,
});
export type LibraryStateV5 = typeof LibraryStateV5.Type;

const migrateLibraryStateFromV5 = (state: LibraryStateV5): LibraryStateV6 => {
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
  const migrated = migrateLibraryEntitiesFromV5(state);
  return {
    ...fields,
    schemaVersion: 6,
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
    projections: [...projections],
  };
};

/** v5 → v6: entities take the current model and Bindings become entries. */
export const LibraryStateFromV5 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV5)),
  Schema.decodeTo(LibraryStateFromV6, {
    decode: SchemaGetter.transform(migrateLibraryStateFromV5),
    encode: SchemaGetter.forbidden(() => "v5 Library state is decode-only"),
  }),
);
