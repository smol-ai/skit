import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
  libraryResponseSchema,
  libraryWriteRequestSchema,
} from "../../distribution/api-contracts.js";
import {
  LibraryResponse,
  LibraryWriteRequest,
  SnapshotArchive,
  SnapshotUploadResponse,
} from "../../library/library-contracts.js";
import { LibraryReadResponse } from "../../library/library-contracts-v4.js";
import {
  CreatedPat,
  ListedPat,
  PrincipalAuthentication,
  RequestDecoding,
  Scope,
} from "./authentication.js";
import {
  ForbiddenOriginResponse,
  ForbiddenResponse,
  InsufficientScopeResponse,
  InvalidExpiryResponse,
  InvalidRequestResponse,
  InvalidScopeResponse,
  InvalidTeamResponse,
  LibraryCreateFailedResponse,
  LibraryNotFoundResponse,
  MembershipNotFoundResponse,
  OwnerRoleImmutableResponse,
  PrincipalNotFoundResponse,
  RateLimitedResponse,
  RevisionConflictResponse,
  SessionRequiredResponse,
  StorageFailureResponse,
  TeamConflictResponse,
  TeamForbiddenResponse,
  TeamSessionRequiredResponse,
  TokenNotFoundResponse,
  UnauthorizedPrincipalResponse,
} from "./errors.js";

export const Team = Schema.Struct({
  team_id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
});
export interface Team extends Schema.Schema.Type<typeof Team> {}
export const TeamMember = Schema.Struct({
  principal_id: Schema.String,
  role: Schema.Literal("member"),
});
export interface TeamMember extends Schema.Schema.Type<typeof TeamMember> {}
export const ReadinessCheck = Schema.Struct({
  name: Schema.Literals([
    "configuration",
    "origin",
    "email",
    "d1",
    "migrations",
    "r2",
    "bootstrap",
  ]),
  status: Schema.Literals(["ok", "error"]),
  detail: Schema.String,
});
export interface ReadinessCheck extends Schema.Schema.Type<typeof ReadinessCheck> {}
export const Readiness = Schema.Struct({
  ready: Schema.Boolean,
  checks: Schema.Array(ReadinessCheck),
});
export interface Readiness extends Schema.Schema.Type<typeof Readiness> {}

export const CreateTokenRequest = Schema.Struct({
  name: Schema.String,
  scopes: Schema.Array(Scope),
  expires_at: Schema.optionalKey(Schema.String),
});
export const TokenList = Schema.Struct({ tokens: Schema.Array(ListedPat) });
export class TokensApi extends HttpApiGroup.make("tokens")
  .add(
    HttpApiEndpoint.post("create", "/api/tokens", {
      payload: CreateTokenRequest,
      success: CreatedPat.pipe(HttpApiSchema.status(201)),
      error: [
        InvalidRequestResponse,
        SessionRequiredResponse,
        ForbiddenOriginResponse,
        RateLimitedResponse,
        InvalidScopeResponse,
        InvalidExpiryResponse,
        UnauthorizedPrincipalResponse,
        StorageFailureResponse,
      ],
    }),
    HttpApiEndpoint.get("list", "/api/tokens", {
      success: TokenList,
      error: [SessionRequiredResponse, StorageFailureResponse],
    }),
    HttpApiEndpoint.delete("revoke", "/api/tokens/:token_id", {
      params: { token_id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [
        InvalidRequestResponse,
        SessionRequiredResponse,
        ForbiddenOriginResponse,
        TokenNotFoundResponse,
        StorageFailureResponse,
      ],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

export const CreateTeamRequest = Schema.Struct({ slug: Schema.String, name: Schema.String });
export const AddTeamMemberRequest = Schema.Struct({ email: Schema.String });
export const TeamResponse = Schema.Struct({ team: Team });
export const TeamMemberResponse = Schema.Struct({ member: TeamMember });
export class TeamsApi extends HttpApiGroup.make("teams")
  .add(
    HttpApiEndpoint.post("create", "/api/teams", {
      payload: CreateTeamRequest,
      success: TeamResponse.pipe(HttpApiSchema.status(201)),
      error: [
        InvalidRequestResponse,
        SessionRequiredResponse,
        ForbiddenOriginResponse,
        TeamSessionRequiredResponse,
        InvalidTeamResponse,
        TeamConflictResponse,
        StorageFailureResponse,
      ],
    }),
    HttpApiEndpoint.post("addMember", "/api/teams/:slug/members", {
      params: { slug: Schema.String },
      payload: AddTeamMemberRequest,
      success: TeamMemberResponse.pipe(HttpApiSchema.status(201)),
      error: [
        InvalidRequestResponse,
        SessionRequiredResponse,
        ForbiddenOriginResponse,
        TeamSessionRequiredResponse,
        TeamForbiddenResponse,
        PrincipalNotFoundResponse,
        OwnerRoleImmutableResponse,
        StorageFailureResponse,
      ],
    }),
    HttpApiEndpoint.delete("removeMember", "/api/teams/:slug/members/:principal_id", {
      params: { slug: Schema.String, principal_id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [
        InvalidRequestResponse,
        SessionRequiredResponse,
        ForbiddenOriginResponse,
        TeamSessionRequiredResponse,
        TeamForbiddenResponse,
        MembershipNotFoundResponse,
        StorageFailureResponse,
      ],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

export class LibrariesApi extends HttpApiGroup.make("libraries")
  .add(
    HttpApiEndpoint.get("readDefault", "/api/library", {
      success: libraryResponseSchema,
      error: [InsufficientScopeResponse, LibraryNotFoundResponse, StorageFailureResponse],
    }),
    HttpApiEndpoint.get("readShared", "/api/libraries/:library_id", {
      params: { library_id: Schema.String },
      success: libraryResponseSchema,
      error: [
        InvalidRequestResponse,
        InsufficientScopeResponse,
        LibraryNotFoundResponse,
        StorageFailureResponse,
      ],
    }),
    HttpApiEndpoint.put("writeDefault", "/api/library", {
      payload: libraryWriteRequestSchema,
      success: libraryResponseSchema,
      error: [
        InvalidRequestResponse,
        InsufficientScopeResponse,
        ForbiddenOriginResponse,
        LibraryCreateFailedResponse,
        RevisionConflictResponse,
        StorageFailureResponse,
      ],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

export class LibrarySnapshotsApi extends HttpApiGroup.make("librarySnapshots")
  .add(
    HttpApiEndpoint.post("upload", "/api/library/snapshots", {
      payload: SnapshotArchive,
      success: SnapshotUploadResponse,
      error: [
        InvalidRequestResponse,
        InsufficientScopeResponse,
        ForbiddenOriginResponse,
        StorageFailureResponse,
      ],
    }),
    HttpApiEndpoint.get("download", "/api/libraries/:library_id/snapshots/:digest", {
      params: { library_id: Schema.String, digest: Schema.String },
      success: SnapshotArchive,
      error: [
        InsufficientScopeResponse,
        LibraryNotFoundResponse,
        ForbiddenResponse,
        StorageFailureResponse,
      ],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

export class LibrarySyncApi extends HttpApiGroup.make("librarySync")
  .add(
    HttpApiEndpoint.get("read", "/api/library/portable", {
      success: LibraryReadResponse,
      error: [InsufficientScopeResponse, LibraryNotFoundResponse, StorageFailureResponse],
    }),
    HttpApiEndpoint.put("write", "/api/library/portable", {
      payload: LibraryWriteRequest,
      success: LibraryResponse,
      error: [
        InsufficientScopeResponse,
        ForbiddenOriginResponse,
        InvalidRequestResponse,
        RevisionConflictResponse,
        StorageFailureResponse,
      ],
    }),
  )
  .middleware(RequestDecoding)
  .middleware(PrincipalAuthentication) {}

const readinessResponse = <const Ready extends boolean>(ready: Ready, status: number) =>
  Schema.Struct({
    schema: Schema.Literal("skit.server.readiness.v1"),
    ...Readiness.fields,
    ready: Schema.Literal(ready),
  }).pipe(HttpApiSchema.status(status));
export const ReadyResponse = readinessResponse(true, 200);
export const NotReadyResponse = readinessResponse(false, 503);
export class ReadinessApi extends HttpApiGroup.make("readiness")
  .add(
    HttpApiEndpoint.get("inspect", "/api/operator/readiness", {
      success: [ReadyResponse, NotReadyResponse],
      error: [SessionRequiredResponse, ForbiddenResponse, StorageFailureResponse],
    }),
  )
  .middleware(PrincipalAuthentication) {}

export class ConsumerAuthenticatedApi extends HttpApi.make("skit-consumer-authenticated-api").add(
  TokensApi,
  TeamsApi,
  LibrariesApi,
  LibrarySnapshotsApi,
  LibrarySyncApi,
  ReadinessApi,
) {}
