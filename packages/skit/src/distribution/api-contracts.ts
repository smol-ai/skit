import { Schema } from "effect";
import { Digest, HarnessName } from "../library/store/state-schema.js";
import {
  apiNonEmptyString as nonEmpty,
  apiSemverPattern,
  isSafePath,
  parseContract,
  parseContractEffect,
  parseWireDescriptor,
  semver,
  SKIT_API_CONTRACT_VERSION,
  skitApiErrorSchema,
  SkitContractError,
  skitSourceKindSchema,
  skitVisibilitySchema,
  type SkitApiError,
  type SkitWireDescriptor,
} from "../protocol/api-contracts.js";

/** Consumer-facing Registry contracts: Distribution reads and portable Library state. */
export {
  isSafePath,
  parseContract,
  parseContractEffect,
  parseWireDescriptor,
  semver,
  SKIT_API_CONTRACT_VERSION,
  skitApiErrorSchema,
  SkitContractError,
  skitSourceKindSchema,
  skitVisibilitySchema,
  type SkitApiError,
  type SkitWireDescriptor,
};

export const releaseSchema = Schema.Struct({
  release_id: Schema.NonEmptyString,
  version: Schema.String.check(Schema.isPattern(apiSemverPattern)),
  revision_id: Schema.optionalKey(Schema.NonEmptyString),
  archive_digest: Digest,
  download_path: Schema.String.check(Schema.isStartsWith("/api/skits/")),
});
export type Release = typeof releaseSchema.Type;

export const serverDiscoverySchema = Schema.Struct({
  schema: Schema.Literal("skit.server.v1"),
  authorSkits: Schema.optionalKey(Schema.String),
  skit: Schema.optionalKey(Schema.String),
  createDraft: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Schema.String),
  publish: Schema.optionalKey(Schema.String),
  download: Schema.String,
  library: Schema.optionalKey(Schema.String),
  sharedLibrary: Schema.optionalKey(Schema.String),
  scopes: Schema.Array(Schema.String),
});
export type ServerDiscovery = typeof serverDiscoverySchema.Type;

export const PortableLibraryRevision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git"),
    commit: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
    tracking_ref: Schema.NullOr(Schema.NonEmptyString),
  }),
  Schema.Struct({ kind: Schema.Literal("release"), version: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("unversioned") }),
]);
export type PortableLibraryRevision = typeof PortableLibraryRevision.Type;
export const PortableLibraryEntry = Schema.Struct({
  collection_ref: Schema.NonEmptyString,
  revision: PortableLibraryRevision,
  locator: Schema.NonEmptyString,
  content_digest: Digest,
});
export type PortableLibraryEntry = typeof PortableLibraryEntry.Type;
export const PortableLibraryScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("repository"), repository: Schema.NonEmptyString }),
]);
export type PortableLibraryScope = typeof PortableLibraryScope.Type;
export const PortableLibraryBinding = Schema.Struct({
  collection_ref: Schema.NonEmptyString,
  harness: HarnessName,
  scope: PortableLibraryScope,
  skills: Schema.mutable(Schema.Array(Schema.NonEmptyString)).check(
    Schema.makeFilter((skills) => new Set(skills).size === skills.length, {
      message: "Library Binding skills must be unique",
    }),
  ),
});
export type PortableLibraryBinding = typeof PortableLibraryBinding.Type;
const LibraryEntries = Schema.mutable(Schema.Array(PortableLibraryEntry)).check(
  Schema.makeFilter(
    (entries) => new Set(entries.map((entry) => entry.collection_ref)).size === entries.length,
    { message: "Library Entries must have unique collection_ref values" },
  ),
);
const LibraryBindings = Schema.mutable(Schema.Array(PortableLibraryBinding)).check(
  Schema.makeFilter(
    (bindings) =>
      new Set(
        bindings.map((binding) =>
          [
            binding.collection_ref,
            binding.harness,
            binding.scope.kind,
            binding.scope.kind === "repository" ? binding.scope.repository : "",
          ].join("\0"),
        ),
      ).size === bindings.length,
    { message: "Library Bindings must have unique SKIT, harness, and scope keys" },
  ),
);
export const LibraryManifest = Schema.Struct({
  schema: Schema.Literal("skit.library.v2").annotate({
    message:
      "Unsupported Library Manifest: expected skit.library.v2. Upgrade the CLI and Registry together; old manifests must be recreated.",
  }),
  entries: LibraryEntries,
  bindings: LibraryBindings,
}).check(
  Schema.makeFilter(
    (manifest) => {
      const entries = new Set(manifest.entries.map((entry) => entry.collection_ref));
      return manifest.bindings.every((binding) => entries.has(binding.collection_ref));
    },
    { message: "Library Bindings must reference an Entry in the same manifest" },
  ),
);
export type LibraryManifest = typeof LibraryManifest.Type;
export const libraryWriteRequestSchema = Schema.Struct({
  expected_revision_id: Schema.optional(Schema.NullOr(nonEmpty)),
  manifest: LibraryManifest,
});
export const libraryResponseSchema = Schema.Struct({
  library: Schema.Struct({
    library_id: nonEmpty,
    revision_id: nonEmpty,
    manifest: LibraryManifest,
  }),
});
export type LibraryWriteRequest = typeof libraryWriteRequestSchema.Type;
export type LibraryResponse = typeof libraryResponseSchema.Type;
