import { Schema, SchemaGetter } from "effect";
import {
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  LibraryStateDocument,
} from "../library-state.js";

const {
  sync_ancestry: _syncAncestry,
  device_skill_selection: _deviceSelection,
  ...fields
} = LibraryState.fields;

/** Frozen v7 state: v8 added only optional sync ancestry. */
export const LibraryStateV7 = Schema.Struct({ ...fields, schemaVersion: Schema.Literal(7) });
export type LibraryStateV7 = typeof LibraryStateV7.Type;

/** A v7 document has neither sync ancestry nor a device-specific selection. */
export const LibraryStateFromV7 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV7)),
  Schema.decodeTo(LibraryStateDocument, {
    decode: SchemaGetter.transform((state) => ({
      ...state,
      schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
    })),
    encode: SchemaGetter.forbidden(() => "v7 Library state is decode-only"),
  }),
);
