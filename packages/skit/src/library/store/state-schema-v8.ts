import { Schema, SchemaGetter } from "effect";
import { LibraryStateFromV9, LibraryStateV9 } from "./state-schema-v9.js";

const { device_skill_selection: _deviceSelection, ...fields } = LibraryStateV9.fields;
const LibraryStateV8 = Schema.Struct({ ...fields, schemaVersion: Schema.Literal(8) });

/** v8 follows account bindings, which remains the default when the selection is absent. */
export const LibraryStateFromV8 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV8)),
  Schema.decodeTo(LibraryStateFromV9, {
    decode: SchemaGetter.transform((state) => ({ ...state, schemaVersion: 9 as const })),
    encode: SchemaGetter.forbidden(() => "v8 Library state is decode-only"),
  }),
);
