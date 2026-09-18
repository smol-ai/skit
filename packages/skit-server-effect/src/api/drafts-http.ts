import { Effect } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { credentialOriginAllowed } from "../auth/request-context.js";
import { Authorization } from "../authorization/service.js";
import { ServerConfiguration } from "../configuration.js";
import {
  DraftCreateRequest,
  DraftUpdateRequest,
  MAX_DRAFT_REQUEST_BYTES,
} from "../drafts/contracts.js";
import { Drafts, type WriteError } from "../drafts/service.js";
import type { DatabaseError } from "../platform/cloudflare.js";
import { AuthoringAuthenticatedApi } from "./authenticated.js";
import { CurrentPrincipal, CurrentRequest } from "./authentication.js";
import {
  forbiddenOriginResponse,
  forbiddenResponse,
  insufficientScopeResponse,
  invalidRequestResponse,
  storageFailureResponse,
} from "./errors.js";
import { schemaBodyJsonLimited } from "./request-body.js";
import { noStore } from "./response.js";

const draftTooLargeResponse = { error: "DRAFT_TOO_LARGE" as const };
const draftNotFoundResponse = { error: "draft_not_found" as const };
const revisionConflictResponse = { error: "REVISION_CONFLICT" as const };
type DraftWriteHttpError =
  | typeof revisionConflictResponse
  | typeof storageFailureResponse
  | { readonly error: string };

const handleWrite = <A>(effect: Effect.Effect<A, WriteError>) =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === "Cloudflare.DatabaseError" ||
      error._tag === "Cloudflare.BlobStorageError" ||
      error._tag === "PlatformError"
        ? Effect.logError("draft storage failed", error)
        : Effect.void,
    ),
    Effect.mapError((error): DraftWriteHttpError => {
      switch (error._tag) {
        case "Draft.RevisionConflict":
          return revisionConflictResponse;
        case "Draft.EncodingError":
          return { error: "INVALID_DRAFT" };
        case "Integrity.Error":
          return { error: error.code };
        default:
          return storageFailureResponse;
      }
    }),
  );

export const draftHandlers = HttpApiBuilder.group(AuthoringAuthenticatedApi, "drafts", (handlers) =>
  Effect.gen(function* () {
    const drafts = yield* Drafts;
    const authorization = yield* Authorization;
    const configuration = yield* ServerConfiguration;

    const requireAuthor = Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      if (!principal.scopes.has("authoring:write"))
        return yield* Effect.fail(insufficientScopeResponse);
      return principal;
    });
    const decodeCreate = (request: HttpServerRequest.HttpServerRequest) =>
      schemaBodyJsonLimited(request, DraftCreateRequest, MAX_DRAFT_REQUEST_BYTES).pipe(
        Effect.mapError((error): typeof draftTooLargeResponse | typeof invalidRequestResponse =>
          error._tag === "Http.RequestBodyTooLarge"
            ? draftTooLargeResponse
            : invalidRequestResponse,
        ),
      );
    const decodeUpdate = (request: HttpServerRequest.HttpServerRequest) =>
      schemaBodyJsonLimited(request, DraftUpdateRequest, MAX_DRAFT_REQUEST_BYTES).pipe(
        Effect.mapError((error): typeof draftTooLargeResponse | typeof invalidRequestResponse =>
          error._tag === "Http.RequestBodyTooLarge"
            ? draftTooLargeResponse
            : invalidRequestResponse,
        ),
      );
    const authorize = <A>(effect: Effect.Effect<A, DatabaseError>) =>
      effect.pipe(
        Effect.tapError((error) => Effect.logError("draft authorization failed", error)),
        Effect.mapError(() => storageFailureResponse),
      );

    return handlers
      .handleRaw("create", ({ request }) =>
        Effect.gen(function* () {
          const principal = yield* requireAuthor;
          const webRequest = yield* CurrentRequest;
          if (
            !credentialOriginAllowed(
              principal.credential,
              webRequest,
              configuration.publicAppOrigin,
            )
          )
            return yield* Effect.fail(forbiddenOriginResponse);
          const body = yield* decodeCreate(request);
          const owner = body.owner ?? body.descriptor.id.split("/")[0];
          if (!(yield* authorize(authorization.ownsNamespace(principal, owner))))
            return yield* Effect.fail(forbiddenResponse);
          const draft = yield* handleWrite(drafts.create(body));
          yield* noStore;
          return { draft };
        }),
      )
      .handle("read", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* requireAuthor;
          if (
            !(yield* authorize(
              authorization.canAuthor(principal, params.owner, params.slug, "read"),
            ))
          )
            return yield* Effect.fail(draftNotFoundResponse);
          const result = yield* drafts.read(params.owner, params.slug).pipe(
            Effect.tapError((error) => Effect.logError("draft read failed", error)),
            Effect.mapError((error) =>
              error._tag === "Draft.TooLarge" ? draftTooLargeResponse : storageFailureResponse,
            ),
          );
          if (result === undefined) return yield* Effect.fail(draftNotFoundResponse);
          yield* noStore;
          return result;
        }),
      )
      .handleRaw("update", ({ params, request }) =>
        Effect.gen(function* () {
          const principal = yield* requireAuthor;
          const webRequest = yield* CurrentRequest;
          if (
            !credentialOriginAllowed(
              principal.credential,
              webRequest,
              configuration.publicAppOrigin,
            )
          )
            return yield* Effect.fail(forbiddenOriginResponse);
          if (
            !(yield* authorize(
              authorization.canAuthor(principal, params.owner, params.slug, "change"),
            ))
          )
            return yield* Effect.fail(forbiddenResponse);
          const body = yield* decodeUpdate(request);
          const draft = yield* handleWrite(
            drafts.write({ ...body, owner: params.owner, slug: params.slug }),
          );
          yield* noStore;
          return { draft };
        }),
      );
  }),
);
