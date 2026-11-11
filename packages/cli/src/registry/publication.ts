import { PublicationResponseError } from "./request-failures.js";
import { Effect, Predicate, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type { RegistryTransportError } from "./registry-http.js";
import { validateAuthenticationOrigin } from "./accounts.js";
import { parseContract, releasePublishRequestSchema } from "@smolai/skit-core/api";
import type { AuthorRemoteHome } from "@smolai/skit-core/author";
import {
  IntegrityFailureResponse,
  PublicationAuthenticatedApi,
  PublishBlockedResponse,
  ReleaseConflictResponse,
} from "@smolai/skit-core/api";
import {
  authenticatedApiMiddleware,
  classifyRegistryApiFailure,
  registryContractFailure,
  markRegistryResponseDecoding,
  registryApiFailure,
} from "./api-client.js";
import {
  AuthorSyncRequired,
  RegistryRejectedWrite,
  AuthenticationRequired,
  CredentialLacksScope,
  PrincipalNotAuthorized,
  PublicationBlocked,
} from "./failures.js";

function stringField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null || !(field in body)) return undefined;
  const value: unknown = Reflect.get(body, field);
  return typeof value === "string" ? value : undefined;
}
/** Discovery, wire encoding and one upload, including body decoding, in the caller's Scope. */
export const publishRelease = Effect.fn("Registry.publishRelease")(function* (
  http: HttpClient.HttpClient.With<RegistryTransportError>,
  input: {
    remote: AuthorRemoteHome;
    token: string;
    root: string;
    version: string;
    revision?: string;
    archive: Uint8Array;
  },
) {
  const { remote, token, root, version, revision } = input;
  const requestedOrigin = URL.parse(remote.origin)?.origin;
  const base = yield* validateAuthenticationOrigin(remote.origin).pipe(
    Effect.mapError(
      () =>
        new PublicationResponseError({
          reason: {
            _tag: "OriginInvalid",
            ...(requestedOrigin === undefined ? {} : { origin: requestedOrigin }),
          },
        }),
    ),
  );
  const owner = remote.namespace;
  const slug = remote.skit;
  const bytes = input.archive;
  const body = yield* parseContract("publish request", releasePublishRequestSchema, {
    version,
    ...(revision === undefined ? {} : { revision_id: revision }),
    archive_base64: Buffer.from(bytes).toString("base64"),
  });
  let publishUrl = `${base}/api/skits/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/releases`;
  const discovered = yield* Effect.gen(function* () {
    let discovery = yield* http.execute(HttpClientRequest.get(`${base}/.well-known/agent-skills/`));
    if (discovery.status === 404)
      discovery = yield* http.execute(HttpClientRequest.get(`${base}/.well-known/skit`));
    if (discovery.status < 200 || discovery.status >= 300) return undefined;
    const template = stringField(yield* discovery.json, "publish");
    if (template === undefined) return undefined;
    const destination = URL.parse(
      template
        .replace("{owner}", encodeURIComponent(owner))
        .replace("{slug}", encodeURIComponent(slug)),
      base,
    );
    const issues: Extract<
      PublicationResponseError["reason"],
      { _tag: "DestinationInvalid" }
    >["issues"][number][] =
      destination === null
        ? ["malformed-url"]
        : [
            ...(destination.origin !== base ? ["different-origin" as const] : []),
            ...(!["https:", "http:"].includes(destination.protocol) ? ["scheme" as const] : []),
            ...(destination.username !== "" || destination.password !== ""
              ? ["credentials" as const]
              : []),
            ...(destination.hash !== "" ? ["fragment" as const] : []),
          ];
    if (destination === null || issues.length)
      return yield* new PublicationResponseError({
        reason: { _tag: "DestinationInvalid", origin: base, issues },
      });
    return destination.toString();
  }).pipe(
    Effect.catchTags({
      RegistryTransportError: () => Effect.undefined,
      HttpClientError: () => Effect.undefined,
    }),
  );
  if (discovered) publishUrl = discovered;
  const client = yield* HttpApiClient.makeWith(PublicationAuthenticatedApi, {
    transformResponse: markRegistryResponseDecoding,
    httpClient: HttpClient.mapRequest(http, HttpClientRequest.setUrl(publishUrl)),
  }).pipe(Effect.provide(authenticatedApiMiddleware(token)));
  return yield* client.publication.publish({ params: { owner, slug }, payload: body }).pipe(
    // Publication never delegates its credential or upload to a redirect target.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.catchTag(
      "HttpClientError",
      (
        error,
      ): Effect.Effect<
        never,
        HttpClientError.HttpClientError | RegistryRejectedWrite | PublicationResponseError
      > => {
        if (error.response !== undefined && error.response.status !== 201) {
          const response = error.response;
          return response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((text) => {
              const failure = {
                origin: base,
                status: response.status,
                body: text.slice(0, 1000),
                failure: error,
              };
              return Effect.fail(
                response.status === 409
                  ? new RegistryRejectedWrite(failure)
                  : new PublicationResponseError({
                      reason: { _tag: "ResponseFailure", ...failure },
                    }),
              );
            }),
          );
        }
        return Effect.fail(error);
      },
    ),
    Effect.mapError((error) => {
      const classified = classifyRegistryApiFailure(error, [201]);
      if (
        Predicate.isTagged(error, "PublicationResponseError") ||
        Predicate.isTagged(error, "RegistryRejectedWrite")
      )
        return error;
      if (classified.kind === "unauthorized")
        return new AuthenticationRequired({
          scopes: "library:sync,authoring:write,publication:write",
        });
      if (classified.kind === "insufficient_scope")
        return new CredentialLacksScope({
          scope: "publication:write",
          scopes: "library:sync,authoring:write,publication:write",
        });
      if (classified.kind === "forbidden")
        return new PrincipalNotAuthorized({ action: "publish this SKIT" });
      if (Schema.is(PublishBlockedResponse)(error)) {
        return new PublicationBlocked({
          reason: "assessment",
          diagnostics: error.diagnostics
            .filter((item) => item.severity === "error")
            .map((item) => ({ _tag: "RegistryDiagnostic" as const, ...item })),
        });
      }
      if (Schema.is(IntegrityFailureResponse)(error) && error.error === "ARCHIVE_MANIFEST_MISMATCH")
        return new AuthorSyncRequired({ root });
      if (classified.kind === "transport")
        return new PublicationResponseError({
          reason: { _tag: "TransportFailed", origin: base, failure: classified.error },
        });
      if (classified.kind === "response_decode")
        return new PublicationResponseError({
          reason: { _tag: "AcknowledgementInvalid", origin: base, failure: classified.failure },
        });
      if (classified.kind === "request_encoding")
        return registryContractFailure("publish request", classified.failure);
      const response = registryApiFailure(error);
      const failure = {
        origin: base,
        ...(response.status === undefined ? {} : { status: response.status }),
        ...(response.code === undefined ? {} : { registryCode: response.code }),
        failure: error,
      };
      if (failure.status === 409 || Schema.is(ReleaseConflictResponse)(error))
        return new RegistryRejectedWrite(failure);
      if (Schema.is(IntegrityFailureResponse)(error)) return new RegistryRejectedWrite(failure);
      return new PublicationResponseError({ reason: { _tag: "ResponseFailure", ...failure } });
    }),
  );
});

export { PublicationResponseError } from "./request-failures.js";
