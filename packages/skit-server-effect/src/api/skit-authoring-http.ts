import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  MAX_ARTIFACT_CONTENT_BYTES,
  RevisionPostRequest,
} from "@smolai/skit-core/universal/authoring";
import { Skits } from "../skits/service.js";
import { AuthoringAuthenticatedApi } from "@smolai/skit-core/api";
import { requirePrincipalScope } from "./authentication.js";
import {
  skitExistsResponse,
  skitNotFoundResponse,
  forbiddenResponse,
  invalidCursorResponse,
  invalidRequestResponse,
  storageFailureResponse,
} from "./errors.js";
import { schemaBodyJsonLimited } from "./request-body.js";
import { noStore } from "./response.js";

// Base64 inflates the content by 4/3; the rest of the JSON body gets a 1 MiB allowance.
const MAX_REVISION_REQUEST_BYTES = Math.ceil(MAX_ARTIFACT_CONTENT_BYTES / 3) * 4 + 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;
const artifactTooLargeResponse = { error: "ARTIFACT_TOO_LARGE" as const };

const storageFailure = (message: string) => (error: unknown) =>
  Effect.logError(message, error).pipe(Effect.andThen(Effect.fail(storageFailureResponse)));

export const skitAuthoringHandlers = HttpApiBuilder.group(
  AuthoringAuthenticatedApi,
  "skits",
  (handlers) =>
    Effect.gen(function* () {
      const skits = yield* Skits;

      const requireAuthor = requirePrincipalScope("authoring:write");
      const prepareChange = Effect.fn("SkitHttp.prepareChange")(function* (
        owner: string,
        slug: string,
      ) {
        const principal = yield* requireAuthor;
        return yield* skits.prepareAuthoring(principal, { owner, slug }).pipe(
          Effect.catchTags({
            "SKIT.Forbidden": () => Effect.fail(forbiddenResponse),
            "Cloudflare.DatabaseError": storageFailure("skit authorization failed"),
          }),
        );
      });
      // Someone who cannot read a SKIT is told it does not exist.
      const prepareRead = Effect.fn("SkitHttp.prepareRead")(function* (
        owner: string,
        slug: string,
      ) {
        const principal = yield* requireAuthor;
        return yield* skits.prepareAuthoring(principal, { owner, slug }).pipe(
          Effect.catchTags({
            "SKIT.Forbidden": () => Effect.fail(skitNotFoundResponse),
            "Cloudflare.DatabaseError": storageFailure("skit authorization failed"),
          }),
        );
      });

      return handlers
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const authoring = yield* prepareChange(payload.owner, payload.slug);
            yield* authoring.create(payload.visibility, payload.request_id).pipe(
              Effect.catchTags({
                "SKIT.Forbidden": () => Effect.fail(forbiddenResponse),
                "SKIT.Exists": () => Effect.fail(skitExistsResponse),
                "Cloudflare.DatabaseError": storageFailure("skit storage failed"),
              }),
            );
            yield* noStore;
            return { skit_id: `${payload.owner}/${payload.slug}` };
          }),
        )
        .handle("current", ({ params }) =>
          Effect.gen(function* () {
            const authoring = yield* prepareRead(params.owner, params.slug);
            const current = yield* authoring.current().pipe(
              Effect.catchTags({
                "SKIT.Forbidden": () => Effect.fail(skitNotFoundResponse),
                "Cloudflare.DatabaseError": storageFailure("skit read failed"),
              }),
            );
            if (current === undefined) return yield* Effect.fail(skitNotFoundResponse);
            yield* noStore;
            return current;
          }),
        )
        .handle("move", ({ params, payload }) =>
          Effect.gen(function* () {
            const authoring = yield* prepareChange(params.owner, params.slug);
            yield* authoring.move(payload.expected, payload.id).pipe(
              Effect.catchTags({
                "SKIT.Forbidden": () => Effect.fail(forbiddenResponse),
                "SKIT.NotFound": () => Effect.fail(skitNotFoundResponse),
                "SKIT.InvalidRevision": (error) => Effect.fail({ error: error.code }),
                "SKIT.CurrentMoved": (error) =>
                  Effect.fail({ error: "REVISION_CONFLICT" as const, current: error.current }),
                "Cloudflare.DatabaseError": storageFailure("skit storage failed"),
              }),
            );
            yield* noStore;
            return { id: payload.id };
          }),
        )
        .handleRaw("post", ({ params, request }) =>
          Effect.gen(function* () {
            const authoring = yield* prepareChange(params.owner, params.slug);
            // The tree's bytes travel as base64, so the body decodes through the JSON codec.
            const body = yield* schemaBodyJsonLimited(
              request,
              Schema.toCodecJson(RevisionPostRequest),
              MAX_REVISION_REQUEST_BYTES,
            ).pipe(
              Effect.mapError((error) =>
                error._tag === "Http.RequestBodyTooLarge"
                  ? artifactTooLargeResponse
                  : invalidRequestResponse,
              ),
            );
            const posted = yield* authoring.post(body).pipe(
              Effect.catchTags({
                "SKIT.Forbidden": () => Effect.fail(forbiddenResponse),
                "SKIT.NotFound": () => Effect.fail(skitNotFoundResponse),
                "SKIT.InvalidRevision": (error) => Effect.fail({ error: error.code }),
                "Integrity.Error": (error) =>
                  Effect.fail(
                    error.code === "ARTIFACT_TOO_LARGE"
                      ? artifactTooLargeResponse
                      : { error: error.code },
                  ),
                "Cloudflare.DatabaseError": storageFailure("skit storage failed"),
                "Cloudflare.BlobStorageError": storageFailure("skit storage failed"),
              }),
            );
            yield* noStore;
            return posted;
          }),
        )
        .handle("revision", ({ params }) =>
          Effect.gen(function* () {
            const authoring = yield* prepareRead(params.owner, params.slug);
            const revision = yield* authoring.revision(params.id).pipe(
              Effect.catchTags({
                "SKIT.Forbidden": () => Effect.fail(skitNotFoundResponse),
                "SKIT.TooLarge": () => Effect.fail(artifactTooLargeResponse),
                "SKIT.BlobMissing": storageFailure("skit read failed"),
                "SKIT.BlobCorrupt": storageFailure("skit read failed"),
                "Cloudflare.DatabaseError": storageFailure("skit read failed"),
                "Cloudflare.BlobStorageError": storageFailure("skit read failed"),
              }),
            );
            if (revision === undefined) return yield* Effect.fail(skitNotFoundResponse);
            yield* noStore;
            return revision;
          }),
        )
        .handle("ancestors", ({ params, query }) =>
          Effect.gen(function* () {
            const authoring = yield* prepareRead(params.owner, params.slug);
            // The cursor is an offset into the fixed set of revisions reachable from `ancestors`.
            if (query.cursor !== undefined && !/^(?:0|[1-9]\d{0,8})$/u.test(query.cursor))
              return yield* Effect.fail(invalidCursorResponse);
            if (query.limit !== undefined && !/^[1-9]\d{0,2}$/u.test(query.limit))
              return yield* Effect.fail(invalidRequestResponse);
            const limit = query.limit === undefined ? DEFAULT_PAGE_LIMIT : Number(query.limit);
            if (limit > MAX_PAGE_LIMIT) return yield* Effect.fail(invalidRequestResponse);
            const page = yield* authoring
              .ancestors(query.ancestors, limit, Number(query.cursor ?? "0"))
              .pipe(
                Effect.catchTags({
                  "SKIT.Forbidden": () => Effect.fail(skitNotFoundResponse),
                  "Cloudflare.DatabaseError": storageFailure("skit read failed"),
                }),
              );
            if (page === undefined) return yield* Effect.fail(skitNotFoundResponse);
            yield* noStore;
            return page;
          }),
        );
    }),
);
