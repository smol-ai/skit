import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as History from "../../history/history.js";
import {
  AuthorSkitDeleteResponse,
  AuthorSkitListResponse,
  CurrentMoveRequest,
  CurrentMoveResponse,
  SkitCreateRequest,
  SkitCreateResponse,
  SkitCurrentResponse,
  RevisionPage,
  RevisionPostRequest,
  RevisionPostResponse,
  RevisionReadResponse,
  releasePublishRequestSchema,
  releasePublishResponseSchema,
  skitValidationDiagnosticsSchema,
} from "../../authoring/api-contracts.js";
export {
  AuthorSkitDeleteResponse,
  AuthorSkitListResponse,
  AuthorSkitSummary,
} from "../../authoring/api-contracts.js";
import { PrincipalAuthentication, RequestDecoding } from "./authentication.js";
import {
  apiErrorStatuses,
  ArchiveTooLargeResponse,
  DeleteRequiresPrivateResponse,
  SkitExistsResponse,
  SkitNotFoundResponse,
  ForbiddenOriginResponse,
  ForbiddenResponse,
  InsufficientScopeResponse,
  InvalidCursorResponse,
  InvalidRequestResponse,
  ReleaseConflictResponse,
  StaleRevisionResponse,
  CurrentRevisionMissingResponse,
  StorageFailureResponse,
} from "./errors.js";

export const ArtifactTooLargeResponse = Schema.Struct({
  error: Schema.Literal("ARTIFACT_TOO_LARGE"),
}).pipe(HttpApiSchema.status(apiErrorStatuses.ARTIFACT_TOO_LARGE));
/** Another device moved `current` first; this is where it points now. */
export const CurrentMovedResponse = Schema.Struct({
  error: Schema.Literal("REVISION_CONFLICT"),
  current: Schema.NullOr(History.RevisionId),
}).pipe(HttpApiSchema.status(apiErrorStatuses.REVISION_CONFLICT));
const dedicatedRevisionErrorCodes = new Set([
  "unauthorized",
  "invalid_request",
  "insufficient_scope",
  "forbidden_origin",
  "forbidden",
  "ARTIFACT_TOO_LARGE",
  "storage_failure",
  "REVISION_CONFLICT",
  "skit_exists",
  "skit_not_found",
]);
export const InvalidRevisionResponse = Schema.Struct({
  error: Schema.String.check(
    Schema.makeFilter((value) => !dedicatedRevisionErrorCodes.has(value), {
      message: "Invalid SKIT errors must not overlap dedicated HTTP responses",
    }),
  ),
}).pipe(HttpApiSchema.status(400));

export class AuthorInventoryApi extends HttpApiGroup.make("authorInventory")
  .add(
    HttpApiEndpoint.get("read", "/api/author/skits", {
      query: {
        limit: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
      },
      success: AuthorSkitListResponse,
      error: [InsufficientScopeResponse, InvalidCursorResponse, StorageFailureResponse],
    }),
  )
  .middleware(PrincipalAuthentication) {}

const commonAuthoringErrors = [
  InvalidRequestResponse,
  InsufficientScopeResponse,
  ForbiddenOriginResponse,
  ForbiddenResponse,
  ArtifactTooLargeResponse,
  StorageFailureResponse,
] as const;

const skitParams = { owner: Schema.String, slug: Schema.String };
const revisionReadErrors = [
  InvalidRequestResponse,
  InsufficientScopeResponse,
  SkitNotFoundResponse,
  ArtifactTooLargeResponse,
  StorageFailureResponse,
] as const;

/**
 * A SKIT's revisions and its one `current` pointer. Posting a revision never changes what is
 * current; only `move` does, and only if `current` still points where the caller expects.
 */
export class SkitAuthoringApi extends HttpApiGroup.make("skits")
  .add(
    HttpApiEndpoint.post("create", "/api/skits", {
      payload: SkitCreateRequest,
      success: SkitCreateResponse.pipe(HttpApiSchema.status(201)),
      error: [...commonAuthoringErrors, InvalidRevisionResponse, SkitExistsResponse],
    }),
    HttpApiEndpoint.get("current", "/api/skits/:owner/:slug/current", {
      params: skitParams,
      success: SkitCurrentResponse,
      error: revisionReadErrors,
    }),
    HttpApiEndpoint.put("move", "/api/skits/:owner/:slug/current", {
      params: skitParams,
      payload: CurrentMoveRequest,
      success: CurrentMoveResponse,
      error: [
        ...commonAuthoringErrors,
        InvalidRevisionResponse,
        SkitNotFoundResponse,
        CurrentMovedResponse,
      ],
    }),
    HttpApiEndpoint.post("post", "/api/skits/:owner/:slug/revisions", {
      params: skitParams,
      payload: RevisionPostRequest,
      success: RevisionPostResponse,
      error: [...commonAuthoringErrors, InvalidRevisionResponse, SkitNotFoundResponse],
    }),
    HttpApiEndpoint.get("revision", "/api/skits/:owner/:slug/revisions/:id", {
      params: { ...skitParams, id: History.RevisionId },
      success: RevisionReadResponse,
      error: revisionReadErrors,
    }),
    HttpApiEndpoint.get("ancestors", "/api/skits/:owner/:slug/revisions", {
      params: skitParams,
      query: {
        ancestors: History.RevisionId,
        limit: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
      },
      success: RevisionPage,
      error: [...revisionReadErrors, InvalidCursorResponse],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

const DeleteQuery = { dry_run: Schema.optionalKey(Schema.Literal("true")) };
export class SkitDeleteApi extends HttpApiGroup.make("skitDelete")
  .add(
    HttpApiEndpoint.delete("deletePrivate", "/api/skits/:owner/:slug", {
      params: { owner: Schema.String, slug: Schema.String },
      query: DeleteQuery,
      success: AuthorSkitDeleteResponse,
      error: [
        InvalidRequestResponse,
        InsufficientScopeResponse,
        ForbiddenOriginResponse,
        SkitNotFoundResponse,
        DeleteRequiresPrivateResponse,
        StorageFailureResponse,
      ],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

export const PublishBlockedResponse = Schema.Struct({
  error: Schema.Literal("publish_blocked"),
  diagnostics: skitValidationDiagnosticsSchema,
}).pipe(HttpApiSchema.status(apiErrorStatuses.publish_blocked));
export const IntegrityErrorCode = Schema.Literals([
  "ARCHIVE_MANIFEST_MISMATCH",
  "CAPABILITY_PATH_MISSING",
  "CONFLICTING_INVOCATION_DECLARATIONS",
  "DESCRIPTOR_CONTENT_MISMATCH",
  "DESCRIPTOR_MISSING",
  "ARTIFACT_FILE_TOO_LARGE",
  "REVISION_MISSING",
  "ARTIFACT_TOO_LARGE",
  "DUPLICATE_FILE_PATH",
  "INVALID_ARCHIVE",
  "INVALID_DESCRIPTOR",
  "INVALID_DESCRIPTOR_ID",
  "INVALID_ARTIFACT",
  "INVALID_INVOCATION_METADATA",
  "PROJECTED_PATH_COLLISION",
  "PROJECTED_RELEASE_TOO_LARGE",
  "PROJECTED_SKILL_TOO_LARGE",
  "SHARED_MAPPING_COLLISION",
  "SHARED_SOURCE_MISSING",
  "SKILL_FILE_MISSING",
]);
export type IntegrityErrorCode = typeof IntegrityErrorCode.Type;
export const IntegrityFailureResponse = Schema.Struct({ error: IntegrityErrorCode }).pipe(
  HttpApiSchema.status(400),
);
export class PublicationApi extends HttpApiGroup.make("publication")
  .add(
    HttpApiEndpoint.post("publish", "/api/skits/:owner/:slug/releases", {
      params: { owner: Schema.String, slug: Schema.String },
      payload: releasePublishRequestSchema,
      success: releasePublishResponseSchema.pipe(HttpApiSchema.status(201)),
      error: [
        InvalidRequestResponse,
        InsufficientScopeResponse,
        ForbiddenOriginResponse,
        ForbiddenResponse,
        ArchiveTooLargeResponse,
        SkitNotFoundResponse,
        StaleRevisionResponse,
        CurrentRevisionMissingResponse,
        PublishBlockedResponse,
        ReleaseConflictResponse,
        IntegrityFailureResponse,
        StorageFailureResponse,
      ],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

export class AuthoringAuthenticatedApi extends HttpApi.make("skit-authoring-authenticated-api").add(
  AuthorInventoryApi,
  SkitAuthoringApi,
  SkitDeleteApi,
) {}
export class PublicationAuthenticatedApi extends HttpApi.make(
  "skit-publication-authenticated-api",
).add(PublicationApi) {}
