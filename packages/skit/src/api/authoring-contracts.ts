import { Schema } from "effect";
import { releaseSchema } from "./consumer-contracts.js";
import * as History from "../history/history.js";
import {
  apiBase64Schema as base64,
  apiNonEmptyString as nonEmpty,
  apiSemverPattern,
  apiSkitSlugSchema as slug,
  semver,
  skitDescriptorRequestSchema,
  skitValidationDiagnosticsSchema,
  skitVisibilitySchema,
} from "./contracts.js";

/**
 * Optional Authoring, SKIT, and Publication wire contracts.
 *
 * A SKIT is a graph of immutable revisions and one `current` pointer. Revisions and trees travel
 * in the History schemas' JSON form (file bytes as base64), so the Registry recomputes the same
 * {@link History.treeHash} and {@link History.revisionId} the device did.
 */
export { skitDescriptorRequestSchema, skitValidationDiagnosticsSchema };

/** Create an empty SKIT. Its `current` stays null until a device moves it. */
export const SkitCreateRequest = Schema.Struct({
  owner: slug,
  slug,
  visibility: skitVisibilitySchema,
  /** A saved creation request may be replayed after its response is lost. */
  request_id: Schema.optionalKey(nonEmpty),
});
export type SkitCreateRequest = typeof SkitCreateRequest.Type;
export const SkitCreateResponse = Schema.Struct({ skit_id: nonEmpty });

/** Record a revision. The Registry checks `id` against its own hash and never moves `current`. */
export const RevisionPostRequest = Schema.Struct({
  id: History.RevisionId,
  revision: History.Revision,
  tree: History.Tree,
});
export type RevisionPostRequest = typeof RevisionPostRequest.Type;
export const RevisionPostResponse = Schema.Struct({
  id: History.RevisionId,
  diagnostics: skitValidationDiagnosticsSchema,
});
export type RevisionPostResponse = typeof RevisionPostResponse.Type;

/** Move `current` to `id`, only if it still points at `expected`. */
export const CurrentMoveRequest = Schema.Struct({
  expected: Schema.NullOr(History.RevisionId),
  id: History.RevisionId,
});
export const CurrentMoveResponse = Schema.Struct({ id: History.RevisionId });

export const SkitCurrentResponse = Schema.Struct({
  skit_id: nonEmpty,
  current: Schema.NullOr(History.RevisionId),
  visibility: skitVisibilitySchema,
});
export type SkitCurrentResponse = typeof SkitCurrentResponse.Type;

/** One revision with its tree, and what validating that tree found. */
export const RevisionReadResponse = Schema.Struct({
  revision: History.Revision,
  tree: History.Tree,
  diagnostics: skitValidationDiagnosticsSchema,
  descriptor: Schema.NullOr(skitDescriptorRequestSchema),
});
export type RevisionReadResponse = typeof RevisionReadResponse.Type;

/** A page of the revisions reachable from one revision, without their trees. */
export const RevisionPage = Schema.Struct({
  revisions: Schema.Array(
    Schema.Struct({
      id: History.RevisionId,
      revision: History.Revision,
      diagnostics: skitValidationDiagnosticsSchema,
    }),
  ),
  next_cursor: Schema.NullOr(nonEmpty),
});
export type RevisionPage = typeof RevisionPage.Type;

export const AuthorSkitSummary = Schema.Struct({
  skit_id: Schema.NonEmptyString,
  visibility: Schema.Literals(["public", "unlisted", "private"]),
  current_revision_id: History.RevisionId,
  current_revision_published: Schema.Boolean,
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
  revisions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  releases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  release_versions: Schema.Array(Schema.String.check(Schema.isPattern(apiSemverPattern))),
  archive_cleanup: Schema.optionalKey(Schema.Literals(["complete", "deferred"])),
});
export type AuthorSkitDeleteResponse = typeof AuthorSkitDeleteResponse.Type;
/** The most files, and uncompressed bytes in total, one SKIT revision or Release may carry. */
export const MAX_ARTIFACT_FILES = 5_000;
export const MAX_ARTIFACT_CONTENT_BYTES = 25 * 1024 * 1024;
export const MAX_RELEASE_ARCHIVE_BYTES = 25 * 1024 * 1024;
/**
 * The most one Skill's served archive may hold, and all of a Release's Skills together: entries, and
 * stored-archive bytes including ZIP headers and names. Shared mappings reuse one file across many
 * projected entries, so these bound what serving a Release builds, which file limits alone do not.
 * Entries stay far below the 65,535 a ZIP without ZIP64 records can describe.
 */
export const MAX_PROJECTED_SKILL_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECTED_RELEASE_BYTES = 32 * 1024 * 1024;
export const MAX_PROJECTED_SKILL_ENTRIES = 1_000;
export const MAX_PROJECTED_RELEASE_ENTRIES = 10_000;
export const MAX_RELEASE_ARCHIVE_BASE64_LENGTH = Math.ceil(MAX_RELEASE_ARCHIVE_BYTES / 3) * 4;
export const releasePublishRequestSchema = Schema.Struct({
  version: semver,
  /** Publish only if the SKIT's `current` is still this revision. */
  revision_id: Schema.optional(History.RevisionId),
  archive_base64: base64.check(Schema.isMaxLength(MAX_RELEASE_ARCHIVE_BASE64_LENGTH)),
});
export const releasePublishResponseSchema = Schema.Struct({ release: releaseSchema });
export type ReleasePublishResponse = typeof releasePublishResponseSchema.Type;
