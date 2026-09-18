import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
  AuthorSkitDeleteResponse,
  AuthorSkitListResponse,
  draftCreateRequestSchema,
  draftReadResponseSchema,
  draftUpdateRequestSchema,
  draftWriteResponseSchema,
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
  ArchiveTooLargeResponse,
  DeleteRequiresPrivateResponse,
  DraftNotFoundResponse,
  ForbiddenOriginResponse,
  ForbiddenResponse,
  InsufficientScopeResponse,
  InvalidCursorResponse,
  InvalidRequestResponse,
  ReleaseConflictResponse,
  SkitNotFoundResponse,
  StaleDraftRevisionResponse,
  StorageFailureResponse,
} from "./errors.js";

export const DraftTooLargeResponse = Schema.Struct({
  error: Schema.Literal("DRAFT_TOO_LARGE"),
}).pipe(HttpApiSchema.status(413));
export const DraftRevisionConflictResponse = Schema.Struct({
  error: Schema.Literal("REVISION_CONFLICT"),
}).pipe(HttpApiSchema.status(409));
const dedicatedDraftErrorCodes = new Set([
  "unauthorized",
  "invalid_request",
  "insufficient_scope",
  "forbidden_origin",
  "forbidden",
  "DRAFT_TOO_LARGE",
  "storage_failure",
  "REVISION_CONFLICT",
]);
export const InvalidDraftResponse = Schema.Struct({
  error: Schema.String.check(
    Schema.makeFilter((value) => !dedicatedDraftErrorCodes.has(value), {
      message: "Invalid Draft errors must not overlap dedicated HTTP responses",
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

const commonDraftErrors = [
  InvalidRequestResponse,
  InsufficientScopeResponse,
  ForbiddenOriginResponse,
  ForbiddenResponse,
  DraftTooLargeResponse,
  StorageFailureResponse,
] as const;

export class DraftApi extends HttpApiGroup.make("drafts")
  .add(
    HttpApiEndpoint.post("create", "/api/skits", {
      payload: draftCreateRequestSchema,
      success: draftWriteResponseSchema.pipe(HttpApiSchema.status(201)),
      error: [...commonDraftErrors, InvalidDraftResponse, DraftRevisionConflictResponse],
    }),
    HttpApiEndpoint.get("read", "/api/skits/:owner/:slug/draft", {
      params: { owner: Schema.String, slug: Schema.String },
      success: draftReadResponseSchema,
      error: [
        InvalidRequestResponse,
        InsufficientScopeResponse,
        DraftNotFoundResponse,
        DraftTooLargeResponse,
        StorageFailureResponse,
      ],
    }),
    HttpApiEndpoint.put("update", "/api/skits/:owner/:slug/draft", {
      params: { owner: Schema.String, slug: Schema.String },
      payload: draftUpdateRequestSchema,
      success: draftWriteResponseSchema,
      error: [...commonDraftErrors, InvalidDraftResponse, DraftRevisionConflictResponse],
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
}).pipe(HttpApiSchema.status(422));
export const IntegrityErrorCode = Schema.Literals([
  "ARCHIVE_MANIFEST_MISMATCH",
  "CAPABILITY_PATH_MISSING",
  "CONFLICTING_INVOCATION_DECLARATIONS",
  "DESCRIPTOR_CONTENT_MISMATCH",
  "DESCRIPTOR_MISSING",
  "DRAFT_FILE_TOO_LARGE",
  "DRAFT_REVISION_MISSING",
  "DRAFT_TOO_LARGE",
  "DUPLICATE_FILE_PATH",
  "INVALID_ARCHIVE",
  "INVALID_DESCRIPTOR",
  "INVALID_DESCRIPTOR_ID",
  "INVALID_DRAFT",
  "INVALID_INVOCATION_METADATA",
  "PROJECTED_PATH_COLLISION",
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
        DraftNotFoundResponse,
        StaleDraftRevisionResponse,
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
  DraftApi,
  SkitDeleteApi,
) {}
export class PublicationAuthenticatedApi extends HttpApi.make(
  "skit-publication-authenticated-api",
).add(PublicationApi) {}
