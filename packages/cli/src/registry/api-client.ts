import { PrincipalAuthentication, RequestDecoding } from "@smolai/skit-core/universal/api";
import { Cause, Effect, Layer, Result, Schema } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { HttpApiMiddleware } from "effect/unstable/httpapi";

const requestDecodingClient = HttpApiMiddleware.layerClient(RequestDecoding, ({ next, request }) =>
  next(request),
);

/** Generated clients share the exact server middleware tags and add auth once at the edge. */
export const authenticatedApiMiddleware = (token?: string) =>
  Layer.merge(
    requestDecodingClient,
    HttpApiMiddleware.layerClient(PrincipalAuthentication, ({ next, request }) =>
      next(token === undefined ? request : HttpClientRequest.bearerToken(request, token)),
    ),
  );

export const sessionApiMiddleware = (cookie: string, origin: string) =>
  Layer.merge(
    requestDecodingClient,
    HttpApiMiddleware.layerClient(PrincipalAuthentication, ({ next, request }) =>
      next(HttpClientRequest.setHeaders(request, { cookie, origin })),
    ),
  );

const RegistryErrorBody = Schema.Struct({ error: Schema.String });

const registryErrorStatuses: Readonly<Record<string, number>> = {
  unauthorized: 401,
  insufficient_scope: 403,
  session_required: 403,
  forbidden: 403,
  forbidden_origin: 403,
  invalid_cursor: 400,
  invalid_request: 400,
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
  library_not_found: 404,
  LIBRARY_CREATE_FAILED: 400,
  REVISION_CONFLICT: 409,
  DRAFT_TOO_LARGE: 413,
  storage_failure: 500,
};

export interface RegistryApiFailure {
  readonly status?: number;
  readonly code?: string;
}

/** Retain the structured reason that the generated client decoded at the Registry boundary. */
export const registryApiFailure = (
  error: unknown,
  options: { readonly defaultStatus?: number } = {},
): RegistryApiFailure => {
  if (Schema.is(RegistryErrorBody)(error))
    return {
      code: error.error,
      status: registryErrorStatuses[error.error] ?? options.defaultStatus,
    };
  if (HttpClientError.isHttpClientError(error)) return { status: error.response?.status };
  return { status: options.defaultStatus };
};

export const registryApiFailureMessage = (
  operation: string,
  error: unknown,
  options: { readonly defaultStatus?: number } = {},
) => {
  const failure = registryApiFailure(error, options);
  const reason = failure.code ?? "Registry returned an invalid error response";
  return failure.status === undefined
    ? `${operation} failed: ${reason}`
    : `${operation} failed (${failure.status}): ${reason}`;
};

export const isSuccessfulResponseDecodeFailure = (
  error: unknown,
  successStatuses: readonly number[],
) =>
  Schema.isSchemaError(error) ||
  (HttpClientError.isHttpClientError(error) &&
    error.response !== undefined &&
    successStatuses.includes(error.response.status) &&
    (error.reason._tag === "DecodeError" || error.reason._tag === "EmptyBodyError"));

/** Collapse HttpApiClient's combined status/decode Cause to one domain failure. */
export const mapRegistryFailureCause = <A, E, R, E2>(
  effect: Effect.Effect<A, E, R>,
  map: (error: E) => E2,
): Effect.Effect<A, E2, R> =>
  Effect.catchCause(effect, (cause) =>
    Result.match(Cause.findError(cause), {
      onFailure: Effect.failCause,
      onSuccess: (error) => Effect.fail(map(error)),
    }),
  );

export const catchRegistryFailureCause = <A, E, R, E2, R2>(
  effect: Effect.Effect<A, E, R>,
  recover: (error: E) => Effect.Effect<A, E | E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.catchCause(effect, (cause) =>
    Result.match(Cause.findError(cause), {
      onFailure: Effect.failCause,
      onSuccess: recover,
    }),
  );
