import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { credentialOriginAllowed } from "../auth/request-context.js";
import { ServerConfiguration } from "../configuration.js";
import { LibrarySync } from "../library/library-sync.js";
import { CurrentPrincipal, CurrentRequest } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "./authenticated.js";
import {
  forbiddenOriginResponse,
  insufficientScopeResponse,
  invalidRequestResponse,
  libraryNotFoundResponse,
  revisionConflictResponse,
  storageFailureResponse,
} from "./errors.js";

export const librarySyncHandlers = HttpApiBuilder.group(
  ConsumerAuthenticatedApi,
  "librarySync",
  (handlers) =>
    Effect.gen(function* () {
      const libraries = yield* LibrarySync;
      const configuration = yield* ServerConfiguration;
      const principalWithScope = Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        if (!principal.scopes.has("library:sync"))
          return yield* Effect.fail(insufficientScopeResponse);
        return principal;
      });
      return handlers.handleAll({
        read: () =>
          Effect.gen(function* () {
            const principal = yield* principalWithScope;
            const library = yield* libraries.read(principal).pipe(
              Effect.catchTags({
                "Library.LibraryRevisionInvalid": () => Effect.fail(storageFailureResponse),
                "Cloudflare.DatabaseError": (error) =>
                  Effect.logError("portable Library read failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
              }),
            );
            if (library === undefined) return yield* Effect.fail(libraryNotFoundResponse);
            return { library };
          }),
        write: ({ payload }) =>
          Effect.gen(function* () {
            const principal = yield* principalWithScope;
            const request = yield* CurrentRequest;
            if (
              !credentialOriginAllowed(principal.credential, request, configuration.publicAppOrigin)
            )
              return yield* Effect.fail(forbiddenOriginResponse);
            const library = yield* libraries
              .write(principal, payload.expected_revision_id, payload.manifest)
              .pipe(
                Effect.catchTags({
                  "Library.LibraryRevisionInvalid": () => Effect.fail(storageFailureResponse),
                  "Library.LibraryRevisionConflict": () => Effect.fail(revisionConflictResponse),
                  "Library.LibrarySnapshotMissing": () => Effect.fail(invalidRequestResponse),
                  "Cloudflare.DatabaseError": (error) =>
                    Effect.logError("portable Library write failed", error).pipe(
                      Effect.andThen(Effect.fail(storageFailureResponse)),
                    ),
                }),
              );
            return { library };
          }),
      });
    }),
);
