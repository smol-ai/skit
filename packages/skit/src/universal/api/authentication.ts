import { Context, Schema } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { InvalidRequestResponse, StorageFailureResponse, UnauthorizedResponse } from "./errors.js";

export const Scope = Schema.Literals(["library:sync", "authoring:write", "publication:write"]);
export type Scope = typeof Scope.Type;

export interface Principal {
  readonly id: string;
  readonly credential: "session" | "personal_access_token";
  readonly scopes: ReadonlySet<Scope>;
  readonly tokenId?: string;
}

export const CreatedPat = Schema.Struct({
  token: Schema.String,
  token_id: Schema.String,
  token_prefix: Schema.String,
  scopes: Schema.Array(Schema.String),
  expires_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export interface CreatedPat extends Schema.Schema.Type<typeof CreatedPat> {}

export const ListedPat = Schema.Struct({
  token_id: Schema.String,
  token_prefix: Schema.String,
  name: Schema.String,
  scopes: Schema.Array(Scope),
  expires_at: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
  last_used_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});
export interface ListedPat extends Schema.Schema.Type<typeof ListedPat> {}

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "@smolai/skit-core/CurrentPrincipal",
) {}
export class CurrentRequest extends Context.Service<CurrentRequest, Request>()(
  "@smolai/skit-core/CurrentRequest",
) {}
export class PrincipalAuthentication extends HttpApiMiddleware.Service<
  PrincipalAuthentication,
  { provides: CurrentPrincipal | CurrentRequest }
>()("@smolai/skit-core/PrincipalAuthentication", {
  error: [UnauthorizedResponse, StorageFailureResponse],
}) {}
export class RequestDecoding extends HttpApiMiddleware.Service<RequestDecoding>()(
  "@smolai/skit-core/RequestDecoding",
  { error: InvalidRequestResponse },
) {}
