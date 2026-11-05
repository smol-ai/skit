import { Schema, SchemaGetter } from "effect";
import { HomeBusy } from "../../platform/lock-failures.js";

// Earlier operation records named the shared home lock after Library. Read those records;
// every newly encoded failure uses the shared resource's canonical name.
const LegacyLibraryBusy = Schema.TaggedStruct("LibraryBusy", { path: Schema.String }).pipe(
  Schema.decodeTo(HomeBusy, {
    decode: SchemaGetter.transform(({ path }) => new HomeBusy({ path })),
    encode: SchemaGetter.forbidden(() => "LibraryBusy operation failures are decode-only"),
  }),
);

export const StoredHomeBusy = Schema.Union([HomeBusy, LegacyLibraryBusy]);
