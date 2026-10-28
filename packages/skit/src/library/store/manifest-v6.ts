import { Schema, SchemaGetter } from "effect";
import { Collection } from "../library-contracts.js";
import { SkillV7 } from "./manifest-v7.js";
import { Hash, HarnessName } from "../../vocabulary.js";
import {
  BindingEntryV7,
  CollectionVersionV7,
  ImportV7,
  LibraryManifestFromV7,
  mergeGlobalBindingsV7,
} from "./manifest-v7.js";

/** Frozen `skit.library.v6` Binding: one per Harness, decoded only to merge them. */
export const BindingV6 = Schema.Struct({
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("global") }),
  entries: Schema.Array(BindingEntryV7),
});

/** Frozen `skit.library.v6`; its entities are v7's, only Bindings changed. */
export const LibraryManifestV6 = Schema.Struct({
  schema: Schema.Literal("skit.library.v6"),
  collections: Schema.Array(Collection),
  skills: Schema.Array(SkillV7),
  retained_copies: Schema.Array(CollectionVersionV7),
  acquisitions: Schema.Array(ImportV7),
  snapshot_digests: Schema.Array(Hash),
  bindings: Schema.Array(BindingV6),
});
export type LibraryManifestV6 = typeof LibraryManifestV6.Type;

/** v6 → v7: per-Harness Bindings merge into the one global Binding. */
export const LibraryManifestFromV6 = LibraryManifestV6.pipe(
  Schema.decodeTo(LibraryManifestFromV7, {
    decode: SchemaGetter.transform((manifest) => ({
      ...manifest,
      schema: "skit.library.v7" as const,
      bindings: mergeGlobalBindingsV7(manifest, manifest.bindings),
    })),
    encode: SchemaGetter.forbidden(() => "v6 portable Library manifests are decode-only"),
  }),
);
