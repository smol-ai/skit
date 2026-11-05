import {
  ApiErrorBody,
  UnauthorizedResponse,
  InsufficientScopeResponse,
  ForbiddenResponse,
  ForbiddenOriginResponse,
  apiErrorStatuses,
  PrincipalAuthentication,
  RequestDecoding,
} from "@smolai/skit-core/universal/api";
import { Data, Effect, Layer, Predicate, Schema } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";

import { isRegistryTransportError } from "./registry-http.js";

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

/** Authenticate as a temporary session: its cookie, or a device-authorization Bearer token. */
export const sessionApiMiddleware = (session: Readonly<Record<string, string>>) =>
  Layer.merge(
    requestDecodingClient,
    HttpApiMiddleware.layerClient(PrincipalAuthentication, ({ next, request }) =>
      next(HttpClientRequest.setHeaders(request, session)),
    ),
  );

export interface RegistryApiFailure {
  readonly status?: number;
  readonly code?: string;
}

/** Retain the structured reason that the generated client decoded at the Registry boundary. */
export const registryApiFailure = (
  error: unknown,
  options: { readonly defaultStatus?: number } = {},
): RegistryApiFailure => {
  if (Schema.is(ApiErrorBody)(error))
    return {
      code: error.error,
      status:
        Object.entries(apiErrorStatuses).find(([code]) => code === error.error)?.[1] ??
        options.defaultStatus,
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

const isResponseBodyReadFailure = (error: unknown, successStatuses: readonly number[]) =>
  HttpClientError.isHttpClientError(error) &&
  error.response !== undefined &&
  successStatuses.includes(error.response.status) &&
  (error.reason._tag === "DecodeError" || error.reason._tag === "EmptyBodyError");

/** Legacy auth/bootstrap clients do not yet mark decoding. Named adapters use the classifier below. */
export const isSuccessfulResponseDecodeFailure = (
  error: unknown,
  successStatuses: readonly number[],
) => Schema.isSchemaError(error) || isResponseBodyReadFailure(error, successStatuses);

/** Marks only decoding: generated request encoders run before this hook. */
class RegistryResponseDecodeError extends Data.TaggedError("RegistryResponseDecodeError")<{
  cause: Schema.SchemaError;
}> {
  override toString() {
    return String(this.cause);
  }
}

export const markRegistryResponseDecoding = (effect: Effect.Effect<unknown, unknown, unknown>) =>
  effect.pipe(
    Effect.mapError((error) =>
      Schema.isSchemaError(error) ? new RegistryResponseDecodeError({ cause: error }) : error,
    ),
  );

/** Shared protocol facts; each named operation retains its own public errors and fields. */
export const classifyRegistryApiFailure = (error: unknown, successStatuses: readonly number[]) => {
  if (isRegistryTransportError(error)) return { kind: "transport" as const, error };
  if (Schema.is(UnauthorizedResponse)(error)) return { kind: "unauthorized" as const };
  if (Schema.is(InsufficientScopeResponse)(error)) return { kind: "insufficient_scope" as const };
  if (Schema.is(ForbiddenResponse)(error) || Schema.is(ForbiddenOriginResponse)(error))
    return { kind: "forbidden" as const };
  if (
    Predicate.isTagged(error, "RegistryResponseDecodeError") ||
    isResponseBodyReadFailure(error, successStatuses)
  )
    return { kind: "response_decode" as const };
  if (Schema.isSchemaError(error)) return { kind: "request_encoding" as const };
  return { kind: "other" as const };
};
