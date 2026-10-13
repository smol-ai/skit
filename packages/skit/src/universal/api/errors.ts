import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";

/**
 * Every error code a Registry route answers with, and the HTTP status it is sent with. The
 * server declares its responses from this table and clients read statuses back from it.
 */
export const apiErrorStatuses = {
  unauthorized: 401,
  insufficient_scope: 403,
  session_required: 403,
  forbidden: 403,
  invalid_cursor: 400,
  invalid_request: 400,
  forbidden_origin: 403,
  skit_not_found: 404,
  delete_requires_private: 409,
  archive_too_large: 413,
  draft_not_found: 404,
  stale_draft_revision: 409,
  release_conflict: 409,
  publish_blocked: 422,
  rate_limited: 429,
  INVALID_SCOPE: 400,
  invalid_expiry: 400,
  UNAUTHORIZED: 400,
  token_not_found: 404,
  SESSION_REQUIRED: 400,
  INVALID_TEAM: 400,
  TEAM_CONFLICT: 409,
  FORBIDDEN: 403,
  PRINCIPAL_NOT_FOUND: 404,
  OWNER_ROLE_IMMUTABLE: 400,
  membership_not_found: 404,
  library_not_found: 404,
  REVISION_CONFLICT: 409,
  DRAFT_TOO_LARGE: 413,
  storage_failure: 500,
} as const;

/** The body every Registry error response carries, whichever code it names. */
export const ApiErrorBody = Schema.Struct({ error: Schema.String });

const errorResponse = <const Code extends keyof typeof apiErrorStatuses>(code: Code) =>
  Schema.Struct({ error: Schema.Literal(code) }).pipe(HttpApiSchema.status(apiErrorStatuses[code]));

export const UnauthorizedResponse = errorResponse("unauthorized");
export const InsufficientScopeResponse = errorResponse("insufficient_scope");
export const SessionRequiredResponse = errorResponse("session_required");
export const ForbiddenResponse = errorResponse("forbidden");
export const InvalidCursorResponse = errorResponse("invalid_cursor");
export const InvalidRequestResponse = errorResponse("invalid_request");
export const ForbiddenOriginResponse = errorResponse("forbidden_origin");
export const SkitNotFoundResponse = errorResponse("skit_not_found");
export const DeleteRequiresPrivateResponse = errorResponse("delete_requires_private");
export const ArchiveTooLargeResponse = errorResponse("archive_too_large");
export const DraftNotFoundResponse = errorResponse("draft_not_found");
export const StaleDraftRevisionResponse = errorResponse("stale_draft_revision");
export const ReleaseConflictResponse = errorResponse("release_conflict");
export const RateLimitedResponse = errorResponse("rate_limited");
export const InvalidScopeResponse = errorResponse("INVALID_SCOPE");
export const InvalidExpiryResponse = errorResponse("invalid_expiry");
export const UnauthorizedPrincipalResponse = errorResponse("UNAUTHORIZED");
export const TokenNotFoundResponse = errorResponse("token_not_found");
export const TeamSessionRequiredResponse = errorResponse("SESSION_REQUIRED");
export const InvalidTeamResponse = errorResponse("INVALID_TEAM");
export const TeamConflictResponse = errorResponse("TEAM_CONFLICT");
export const TeamForbiddenResponse = errorResponse("FORBIDDEN");
export const PrincipalNotFoundResponse = errorResponse("PRINCIPAL_NOT_FOUND");
export const OwnerRoleImmutableResponse = errorResponse("OWNER_ROLE_IMMUTABLE");
export const MembershipNotFoundResponse = errorResponse("membership_not_found");
export const LibraryNotFoundResponse = errorResponse("library_not_found");
export const RevisionConflictResponse = errorResponse("REVISION_CONFLICT");
export const StorageFailureResponse = errorResponse("storage_failure");

export const unauthorizedResponse = { error: "unauthorized" as const };
export const insufficientScopeResponse = { error: "insufficient_scope" as const };
export const sessionRequiredResponse = { error: "session_required" as const };
export const forbiddenResponse = { error: "forbidden" as const };
export const invalidCursorResponse = { error: "invalid_cursor" as const };
export const invalidRequestResponse = { error: "invalid_request" as const };
export const forbiddenOriginResponse = { error: "forbidden_origin" as const };
export const skitNotFoundResponse = { error: "skit_not_found" as const };
export const deleteRequiresPrivateResponse = { error: "delete_requires_private" as const };
export const archiveTooLargeResponse = { error: "archive_too_large" as const };
export const draftNotFoundResponse = { error: "draft_not_found" as const };
export const staleDraftRevisionResponse = { error: "stale_draft_revision" as const };
export const releaseConflictResponse = { error: "release_conflict" as const };
export const rateLimitedResponse = { error: "rate_limited" as const };
export const invalidScopeResponse = { error: "INVALID_SCOPE" as const };
export const invalidExpiryResponse = { error: "invalid_expiry" as const };
export const unauthorizedPrincipalResponse = { error: "UNAUTHORIZED" as const };
export const tokenNotFoundResponse = { error: "token_not_found" as const };
export const teamSessionRequiredResponse = { error: "SESSION_REQUIRED" as const };
export const invalidTeamResponse = { error: "INVALID_TEAM" as const };
export const teamConflictResponse = { error: "TEAM_CONFLICT" as const };
export const teamForbiddenResponse = { error: "FORBIDDEN" as const };
export const principalNotFoundResponse = { error: "PRINCIPAL_NOT_FOUND" as const };
export const ownerRoleImmutableResponse = { error: "OWNER_ROLE_IMMUTABLE" as const };
export const membershipNotFoundResponse = { error: "membership_not_found" as const };
export const libraryNotFoundResponse = { error: "library_not_found" as const };
export const revisionConflictResponse = { error: "REVISION_CONFLICT" as const };
export const storageFailureResponse = { error: "storage_failure" as const };
