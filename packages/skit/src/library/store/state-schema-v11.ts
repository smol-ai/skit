import { Schema, SchemaGetter } from "effect";
import {
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  LibraryStateDocument,
} from "../library-state.js";

// Frozen v11 state. Every older state migrates through this shape, so it stays as v11 defined it
// while the current model moves on.

const { schemaVersion: _schemaVersion, operations: _operations, ...fields } = LibraryState.fields;
export const LibraryStateV11 = Schema.Struct({ ...fields, schemaVersion: Schema.Literal(11) });
export type LibraryStateV11 = typeof LibraryStateV11.Type;

/** v11 → v12: state records setup operations; a v11 Library has none. */
export const LibraryStateFromV11 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV11)),
  Schema.decodeTo(LibraryStateDocument, {
    decode: SchemaGetter.transform((state: LibraryStateV11): LibraryState => ({
      ...state,
      schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
      operations: [],
    })),
    encode: SchemaGetter.forbidden(() => "v11 Library state is decode-only"),
  }),
);
