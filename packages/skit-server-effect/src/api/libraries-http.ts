import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerConfiguration } from "../configuration.js";
import { credentialOriginAllowed } from "../auth/request-context.js";
import { Libraries, type LibraryRevisionMissing } from "../library/service.js";
import type { DatabaseError } from "../platform/cloudflare.js";
import { CurrentPrincipal, CurrentRequest } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "./authenticated.js";
import {
  forbiddenOriginResponse,
  insufficientScopeResponse,
  libraryCreateFailedResponse,
  libraryNotFoundResponse,
  revisionConflictResponse,
  storageFailureResponse,
} from "./errors.js";

export const libraryHandlers = HttpApiBuilder.group(
  ConsumerAuthenticatedApi,
  "libraries",
  (handlers) =>
    Effect.gen(function* () {
      const libraries = yield* Libraries;
      const configuration = yield* ServerConfiguration;
      const requireLibraryPrincipal = Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        if (!principal.scopes.has("library:sync"))
          return yield* Effect.fail(insufficientScopeResponse);
        return principal;
      });
      const readFailure = {
        "Library.RevisionMissing": (error: LibraryRevisionMissing) =>
          Effect.logError("library revision missing", error).pipe(
            Effect.andThen(Effect.fail(storageFailureResponse)),
          ),
        "Cloudflare.DatabaseError": (error: DatabaseError) =>
          Effect.logError("library storage failed", error).pipe(
            Effect.andThen(Effect.fail(storageFailureResponse)),
          ),
      };

      return handlers.handleAll({
        readDefault: () =>
          Effect.gen(function* () {
            const principal = yield* requireLibraryPrincipal;
            const library = yield* libraries
              .readDefault(principal)
              .pipe(Effect.catchTags(readFailure));
            if (library === undefined) return yield* Effect.fail(libraryNotFoundResponse);
            return { library };
          }),
        readShared: ({ params }) =>
          Effect.gen(function* () {
            const principal = yield* requireLibraryPrincipal;
            const library = yield* libraries
              .readById(principal, params.library_id)
              .pipe(Effect.catchTags(readFailure));
            if (library === undefined) return yield* Effect.fail(libraryNotFoundResponse);
            return { library };
          }),
        writeDefault: ({ payload }) =>
          Effect.gen(function* () {
            const principal = yield* requireLibraryPrincipal;
            const request = yield* CurrentRequest;
            if (
              !credentialOriginAllowed(principal.credential, request, configuration.publicAppOrigin)
            )
              return yield* Effect.fail(forbiddenOriginResponse);
            const library = yield* libraries
              .write(principal, payload.expected_revision_id, payload.manifest)
              .pipe(
                Effect.catchTags({
                  "Library.CreateFailed": () => Effect.fail(libraryCreateFailedResponse),
                  "Library.RevisionConflict": () => Effect.fail(revisionConflictResponse),
                  "Cloudflare.DatabaseError": (error) =>
                    Effect.logError("library write storage failed", error).pipe(
                      Effect.andThen(Effect.fail(storageFailureResponse)),
                    ),
                }),
              );
            return { library };
          }),
      });
    }),
);
