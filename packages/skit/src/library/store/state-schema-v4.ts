import { Schema } from "effect";
import {
  PortableAcquisitionV4,
  PortableCollectionV4,
  migratePortableEntitiesFromV4,
} from "../portable-contracts.js";
import {
  PortableAdoptionReceipt,
  PortableDeviceBinding,
  PortableRepositoryBinding,
  ManagedProjection,
  currentLibraryState,
  type LibraryState,
} from "../portable-local-state.js";
import { PortableRetainedCopy, PortableSkill } from "../portable-contracts.js";
import { LibraryDeviceStateFields } from "./state-schema.js";

export const LibraryStateV4 = Schema.Struct({
  ...LibraryDeviceStateFields,
  schemaVersion: Schema.Literal(4),
  collections: Schema.mutable(Schema.Array(PortableCollectionV4)),
  skills: Schema.mutable(Schema.Array(PortableSkill)),
  retained_copies: Schema.mutable(Schema.Array(PortableRetainedCopy)),
  acquisitions: Schema.mutable(Schema.Array(PortableAcquisitionV4)),
  global_bindings: Schema.mutable(Schema.Array(PortableDeviceBinding)),
  local_bindings: Schema.mutable(Schema.Array(PortableRepositoryBinding)),
  projections: Schema.mutable(Schema.Array(ManagedProjection)),
  adoption_receipts: Schema.mutable(Schema.Array(PortableAdoptionReceipt)),
});
export type LibraryStateV4 = typeof LibraryStateV4.Type;

export const migrateLibraryStateFromV4 = (state: LibraryStateV4): LibraryState => {
  const migrated = migratePortableEntitiesFromV4(state);
  const { schemaVersion: _legacyVersion, ...fields } = state;
  return currentLibraryState({
    ...fields,
    collections: migrated.collections,
    acquisitions: migrated.acquisitions,
  });
};
