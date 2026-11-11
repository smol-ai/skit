import { Schema } from "effect";
/** Invalid marker documents confer no ownership. These are passive inspection states. */
export const OwnershipMarkerInvalidReason = Schema.TaggedUnion({
  NotObject: {},
  InvalidFields: {},
  InvalidJson: {},
});
export type OwnershipMarkerInvalidReason = typeof OwnershipMarkerInvalidReason.Type;
