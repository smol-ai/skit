import { Schema } from "effect";
import { Digest } from "../library/store/state-schema.js";
import {
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

/** Consumer-facing Registry contracts: Distribution reads and Server discovery. */
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
  download_path: Schema.String.check(Schema.isStartingWith("/api/skits/")),
});
export type Release = typeof releaseSchema.Type;

export const serverDiscoverySchema = Schema.Struct({
  schema: Schema.Literal("skit.server.v1"),
  // Diagnostic metadata must not prevent discovery of future server builds.
  build: Schema.optionalKey(Schema.Unknown),
  authorSkits: Schema.optionalKey(Schema.String),
  skit: Schema.optionalKey(Schema.String),
  createDraft: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Schema.String),
  publish: Schema.optionalKey(Schema.String),
  download: Schema.String,
  scopes: Schema.Array(Schema.String),
});
export type ServerDiscovery = typeof serverDiscoverySchema.Type;
