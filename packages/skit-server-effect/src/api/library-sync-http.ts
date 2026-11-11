import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ServerLibrary } from "../library/service.js";
import { requirePrincipalScope } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "@smolai/skit-core/api";
import {
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
      const libraries = yield* ServerLibrary;
      const principalWithScope = requirePrincipalScope("library:sync");
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
            const library = yield* libraries
              .write(principal, payload.expected_revision_id, payload.manifest)
              .pipe(
                Effect.catchTags({
                  "Library.LibraryRevisionInvalid": () => Effect.fail(storageFailureResponse),
                  "Library.LibraryRevisionConflict": () => Effect.fail(revisionConflictResponse),
                  "Library.CollectionVersionMissing": () => Effect.fail(invalidRequestResponse),
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
