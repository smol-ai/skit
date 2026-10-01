import { Schema, SchemaGetter } from "effect";
import {
  Acquisition,
  BindingEntry,
  Collection,
  CURRENT_PORTABLE_LIBRARY_SCHEMA,
  LibraryManifest,
  mergeGlobalBindings,
  RetainedCopy,
  Skill,
} from "./library-contracts.js";
import { Digest, HarnessName } from "./store/state-schema.js";

/** Frozen `skit.library.v6` Binding: one per Harness, decoded only to merge them. */
export const BindingV6 = Schema.Struct({
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("global") }),
  entries: Schema.Array(BindingEntry),
});

/** Frozen `skit.library.v6`; its entities are the current ones, only Bindings changed. */
export const LibraryManifestV6 = Schema.Struct({
  schema: Schema.Literal("skit.library.v6"),
  collections: Schema.Array(Collection),
  skills: Schema.Array(Skill),
  retained_copies: Schema.Array(RetainedCopy),
  acquisitions: Schema.Array(Acquisition),
  snapshot_digests: Schema.Array(Digest),
  bindings: Schema.Array(BindingV6),
});
export type LibraryManifestV6 = typeof LibraryManifestV6.Type;

export const LibraryManifestFromV6 = LibraryManifestV6.pipe(
  Schema.decodeTo(LibraryManifest, {
    decode: SchemaGetter.transform((manifest) => ({
      ...manifest,
      schema: CURRENT_PORTABLE_LIBRARY_SCHEMA,
      bindings: mergeGlobalBindings(manifest, manifest.bindings),
    })),
    encode: SchemaGetter.forbidden(() => "v6 portable Library manifests are decode-only"),
  }),
);
