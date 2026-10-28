import { Schema, SchemaGetter } from "effect";
import { LibraryStateFromV9, LibraryStateV9 } from "./state-schema-v9.js";

const {
  sync_ancestry: _syncAncestry,
  device_skill_selection: _deviceSelection,
  ...fields
} = LibraryStateV9.fields;

/** Frozen v7 state: v8 added only optional sync ancestry. */
export const LibraryStateV7 = Schema.Struct({ ...fields, schemaVersion: Schema.Literal(7) });
export type LibraryStateV7 = typeof LibraryStateV7.Type;

/** A v7 document has neither sync ancestry nor a device-specific selection. */
export const LibraryStateFromV7 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV7)),
  Schema.decodeTo(LibraryStateFromV9, {
    decode: SchemaGetter.transform((state) => ({ ...state, schemaVersion: 9 as const })),
    encode: SchemaGetter.forbidden(() => "v7 Library state is decode-only"),
  }),
);
