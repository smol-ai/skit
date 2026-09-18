import { Schema } from "effect";
import { releaseSchema } from "../distribution/api-contracts.js";
import { digestSchema as effectDigest, safePathSchema } from "../schemas.js";
import {
  apiBase64Schema as base64,
  apiNonEmptyString as nonEmpty,
  apiSemverPattern,
  apiSkitSlugSchema as slug,
  semver,
  skitDescriptorRequestSchema,
  skitSourceKindSchema,
  skitValidationDiagnosticsSchema,
  skitVisibilitySchema,
} from "../protocol/api-contracts.js";

/** Optional Authoring, Draft, and Publication wire contracts. */
export const draftFileInputSchema = Schema.Struct({
  path: safePathSchema,
  content_base64: base64,
  media_type: nonEmpty,
  executable: Schema.optional(Schema.Boolean),
});
export { skitDescriptorRequestSchema, skitValidationDiagnosticsSchema };
const draftWriteFields = {
  title: nonEmpty,
  description: Schema.optional(Schema.String),
  visibility: skitVisibilitySchema,
  descriptor: skitDescriptorRequestSchema,
  diagnostics: Schema.optional(skitValidationDiagnosticsSchema),
  files: Schema.Array(draftFileInputSchema).check(Schema.isMinLength(1)),
  expected_revision_id: Schema.optional(Schema.String),
  source_kind: Schema.optional(skitSourceKindSchema),
  source_revision: Schema.optional(Schema.String),
};
export const draftUpdateRequestSchema = Schema.Struct(draftWriteFields);
export const draftCreateRequestSchema = Schema.Struct({
  ...draftWriteFields,
  slug,
  owner: Schema.optional(slug),
});
export const draftRevisionSchema = Schema.Struct({
  skit_id: nonEmpty,
  revision_id: nonEmpty,
  manifest_digest: effectDigest,
  bundle_digest: effectDigest,
  files: Schema.Array(
    Schema.Struct({
      path: safePathSchema,
      digest: effectDigest,
      bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      media_type: nonEmpty,
      executable: Schema.Boolean,
    }),
  ),
  diagnostics: skitValidationDiagnosticsSchema,
});
export const draftWriteResponseSchema = Schema.Struct({ draft: draftRevisionSchema });
export const draftFileSchema = Schema.Struct({
  path: safePathSchema,
  media_type: nonEmpty,
  executable: Schema.Boolean,
  content_base64: base64,
});
export const draftReadResponseSchema = Schema.Struct({
  draft: Schema.Struct({
    revision_id: nonEmpty,
    bundle_digest: effectDigest,
    title: Schema.String,
    description: Schema.optional(Schema.NullOr(Schema.String)),
    visibility: skitVisibilitySchema,
    descriptor: skitDescriptorRequestSchema,
    diagnostics: skitValidationDiagnosticsSchema,
    files: Schema.Array(draftFileSchema),
  }),
});
export const AuthorSkitSummary = Schema.Struct({
  skit_id: Schema.NonEmptyString,
  visibility: Schema.Literals(["public", "unlisted", "private"]),
  draft_revision_id: Schema.NonEmptyString,
  most_recent_release_version: Schema.NullOr(
    Schema.String.check(Schema.isPattern(apiSemverPattern)),
  ),
});
export type AuthorSkitSummary = typeof AuthorSkitSummary.Type;
export const AuthorSkitListResponse = Schema.Struct({
  skits: Schema.Array(AuthorSkitSummary),
  next_cursor: Schema.NullOr(Schema.NonEmptyString),
});
export type AuthorSkitListResponse = typeof AuthorSkitListResponse.Type;
export const AuthorSkitDeleteResponse = Schema.Struct({
  status: Schema.Literals(["delete_ready", "deleted", "absent"]),
  skit_id: Schema.NonEmptyString,
  changed: Schema.Boolean,
  draft_revisions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  releases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  release_versions: Schema.Array(Schema.String.check(Schema.isPattern(apiSemverPattern))),
  archive_cleanup: Schema.optionalKey(Schema.Literals(["complete", "deferred"])),
});
export type AuthorSkitDeleteResponse = typeof AuthorSkitDeleteResponse.Type;
export const MAX_RELEASE_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_RELEASE_ARCHIVE_BASE64_LENGTH = Math.ceil(MAX_RELEASE_ARCHIVE_BYTES / 3) * 4;
export const releasePublishRequestSchema = Schema.Struct({
  version: semver,
  revision_id: Schema.optional(nonEmpty),
  archive_base64: base64.check(Schema.isMaxLength(MAX_RELEASE_ARCHIVE_BASE64_LENGTH)),
});
export const releasePublishResponseSchema = Schema.Struct({ release: releaseSchema });
export type DraftFileInput = typeof draftFileInputSchema.Type;
export type DraftUpdateRequest = typeof draftUpdateRequestSchema.Type;
export type DraftCreateRequest = typeof draftCreateRequestSchema.Type;
export type DraftRevision = typeof draftRevisionSchema.Type;
export type DraftWriteResponse = typeof draftWriteResponseSchema.Type;
export type DraftReadResponse = typeof draftReadResponseSchema.Type;
export type ReleasePublishRequest = typeof releasePublishRequestSchema.Type;
export type ReleasePublishResponse = typeof releasePublishResponseSchema.Type;
