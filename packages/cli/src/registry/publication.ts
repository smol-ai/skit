import { Data, Effect, Predicate, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  FailureTypeId,
  SkitContractError,
  parseContract,
  releasePublishRequestSchema,
  type SkitFailure,
} from "@smolai/skit-core";
import type { AuthorRemoteHome } from "@smolai/skit-core/author";
import {
  IntegrityFailureResponse,
  PublicationAuthenticatedApi,
  PublishBlockedResponse,
  ReleaseConflictResponse,
} from "@smolai/skit-core/universal/api";
import { RegistryHttp } from "./registry-http.js";
import {
  authenticatedApiMiddleware,
  classifyRegistryApiFailure,
  markRegistryResponseDecoding,
  registryApiFailure,
  registryApiFailureMessage,
} from "./api-client.js";
import {
  AuthorSyncRequired,
  RegistryRejectedWrite,
  AuthenticationRequired,
  CredentialLacksScope,
  PrincipalNotAuthorized,
  PublicationBlocked,
} from "./failures.js";

export class PublicationResponseError
  extends Data.TaggedError("PublicationResponseError")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then publish again.";
}
function discoveryUrl(template: string, base: string): Effect.Effect<string, TypeError> {
  const url = URL.parse(template, base);
  return url
    ? Effect.succeed(url.toString())
    : Effect.fail(new TypeError(`Invalid URL: ${template} against ${base}`));
}
function stringField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null || !(field in body)) return undefined;
  const value: unknown = Reflect.get(body, field);
  return typeof value === "string" ? value : undefined;
}
/** Discovery, wire encoding and one upload, including body decoding, in the caller's Scope. */
export const publishRelease = Effect.fn("Registry.publishRelease")(function* (input: {
  remote: AuthorRemoteHome;
  token: string;
  version: string;
  revision?: string;
  archive: Uint8Array;
  commandPath: string;
}) {
  const { remote, token, version, revision, commandPath } = input;
  const base = remote.origin.replace(/\/$/, "");
  const owner = remote.namespace;
  const slug = remote.skit;
  const http = yield* (yield* RegistryHttp).client;
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
    return template === undefined
      ? undefined
      : yield* discoveryUrl(
          template
            .replace("{owner}", encodeURIComponent(owner))
            .replace("{slug}", encodeURIComponent(slug)),
          base,
        );
  }).pipe(
    Effect.catchTags({
      RegistryTransportError: () => Effect.succeed(undefined),
      HttpClientError: () => Effect.succeed(undefined),
    }),
    // Only discovery URL syntax remains in this channel.
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (discovered) publishUrl = discovered;
  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(PublicationAuthenticatedApi, {
    transformResponse: markRegistryResponseDecoding,
    httpClient: HttpClient.mapRequest(transport, HttpClientRequest.setUrl(publishUrl)),
  }).pipe(Effect.provide(authenticatedApiMiddleware(token)));
  return yield* client.publication.publish({ params: { owner, slug }, payload: body }).pipe(
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
              const detail = `SKIT publish failed (${response.status}): ${(text || "Registry returned an invalid error response").slice(0, 1000)}`;
              return Effect.fail(
                response.status === 409
                  ? new RegistryRejectedWrite({ detail })
                  : new PublicationResponseError({ message: detail }),
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
        const details = error.diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => item.message)
          .join("\n");
        return new PublicationBlocked({
          reason: "assessment",
          detail: details ? `:\n${details}` : "",
        });
      }
      if (Schema.is(IntegrityFailureResponse)(error) && error.error === "ARCHIVE_MANIFEST_MISMATCH")
        return new AuthorSyncRequired({ commandPath });
      if (classified.kind === "transport") return classified.error;
      if (classified.kind === "response_decode" || classified.kind === "request_encoding")
        return new SkitContractError({
          contract: classified.kind === "request_encoding" ? "publish request" : "publish response",
          issues: [{ path: "", message: String(error) }],
        });
      const failure = registryApiFailure(error, { defaultStatus: 400 });
      const detail = registryApiFailureMessage("SKIT publish", error, { defaultStatus: 400 });
      if (failure.status === 409 || Schema.is(ReleaseConflictResponse)(error))
        return new RegistryRejectedWrite({ detail });
      if (Schema.is(IntegrityFailureResponse)(error)) return new RegistryRejectedWrite({ detail });
      return new PublicationResponseError({ message: detail });
    }),
  );
});
