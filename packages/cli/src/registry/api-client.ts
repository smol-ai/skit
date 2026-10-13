import {
  ApiErrorBody,
  apiErrorStatuses,
  PrincipalAuthentication,
  RequestDecoding,
} from "@smolai/skit-core/universal/api";
import { Layer, Schema } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";

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

export const isSuccessfulResponseDecodeFailure = (
  error: unknown,
  successStatuses: readonly number[],
) =>
  Schema.isSchemaError(error) ||
  (HttpClientError.isHttpClientError(error) &&
    error.response !== undefined &&
    successStatuses.includes(error.response.status) &&
    (error.reason._tag === "DecodeError" || error.reason._tag === "EmptyBodyError"));
