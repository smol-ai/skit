import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  MAX_RELEASE_ARCHIVE_BASE64_LENGTH,
  MAX_RELEASE_ARCHIVE_BYTES,
  releasePublishRequestSchema,
} from "@smolai/skit-core/universal/authoring";
import { Skits } from "../skits/service.js";
import { requirePrincipalScope } from "./authentication.js";
import { PublicationAuthenticatedApi } from "@smolai/skit-core/api";
import {
  archiveTooLargeResponse,
  skitNotFoundResponse,
  forbiddenResponse,
  invalidRequestResponse,
  releaseConflictResponse,
  staleRevisionResponse,
  currentRevisionMissingResponse,
  storageFailureResponse,
} from "./errors.js";
import { schemaBodyJsonLimited } from "./request-body.js";
import { noStore } from "./response.js";

// The base64 archive plus room for the rest of the JSON body.
const MAX_PUBLISH_REQUEST_BYTES = MAX_RELEASE_ARCHIVE_BASE64_LENGTH + 4_096;

export const publicationHandlers = HttpApiBuilder.group(
  PublicationAuthenticatedApi,
  "publication",
  (handlers) =>
    Effect.gen(function* () {
      const skits = yield* Skits;

      return handlers.handleRaw("publish", ({ params, request: rawRequest }) =>
        Effect.gen(function* () {
          const principal = yield* requirePrincipalScope("publication:write");

          const publication = yield* skits
            .preparePublication(principal, { owner: params.owner, slug: params.slug })
            .pipe(
              Effect.tapError((error) =>
                Effect.logError("publication authorization failed", error),
              ),
              Effect.catchTags({
                "Publication.Forbidden": () => Effect.fail(forbiddenResponse),
                "Cloudflare.DatabaseError": () => Effect.fail(storageFailureResponse),
              }),
            );

          const decoded = yield* schemaBodyJsonLimited(
            rawRequest,
            releasePublishRequestSchema,
            MAX_PUBLISH_REQUEST_BYTES,
          ).pipe(Effect.result);
          if (decoded._tag === "Failure")
            return yield* Effect.fail(
              decoded.failure._tag === "Http.RequestBodyTooLarge"
                ? archiveTooLargeResponse
                : invalidRequestResponse,
            );
          const payload = decoded.success;
          const archive = Uint8Array.from(atob(payload.archive_base64), (value) =>
            value.charCodeAt(0),
          );
          if (archive.byteLength > MAX_RELEASE_ARCHIVE_BYTES)
            return yield* Effect.fail(archiveTooLargeResponse);

          const release = yield* publication
            .publish({
              version: payload.version,
              revisionId: payload.revision_id,
              archive,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  switch (error._tag) {
                    case "Publication.Forbidden":
                      return yield* Effect.fail(forbiddenResponse);
                    case "Publication.SkitNotFound":
                      return yield* Effect.fail(skitNotFoundResponse);
                    case "Publication.CurrentRevisionMissing":
                      return yield* Effect.fail(currentRevisionMissingResponse);
                    case "Publication.StaleRevision":
                      return yield* Effect.fail(staleRevisionResponse);
                    case "Publication.PublishBlocked":
                      return yield* Effect.fail({
                        error: "publish_blocked" as const,
                        diagnostics: error.diagnostics,
                      });
                    case "Publication.ReleaseConflict":
                      return yield* Effect.fail(releaseConflictResponse);
                    case "Integrity.Error":
                      return yield* Effect.fail({ error: error.code });
                    default:
                      return yield* Effect.logError("publication storage failed", error).pipe(
                        Effect.andThen(Effect.fail(storageFailureResponse)),
                      );
                  }
                }),
              ),
            );

          yield* noStore;
          return {
            release: {
              ...release,
              download_path: `/api/skits/${params.owner}/${params.slug}/releases/${payload.version}/download`,
            },
          };
        }),
      );
    }),
);
