import { Schema, SchemaGetter } from "effect";
import {
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  LibraryStateDocument,
} from "../library-state.js";

const { device_skill_selection: _deviceSelection, ...fields } = LibraryState.fields;
const LibraryStateV8 = Schema.Struct({ ...fields, schemaVersion: Schema.Literal(8) });

/** v8 follows account bindings, which remains the default when the selection is absent. */
export const LibraryStateFromV8 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV8)),
  Schema.decodeTo(LibraryStateDocument, {
    decode: SchemaGetter.transform((state) => ({
      ...state,
      schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
    })),
    encode: SchemaGetter.forbidden(() => "v8 Library state is decode-only"),
  }),
);
