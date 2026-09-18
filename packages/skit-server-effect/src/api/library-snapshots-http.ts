import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { credentialOriginAllowed } from "../auth/request-context.js";
import { ServerConfiguration } from "../configuration.js";
import { LibrarySnapshots } from "../library/snapshots.js";
import { CurrentPrincipal, CurrentRequest } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "./authenticated.js";
import {
  forbiddenOriginResponse,
  forbiddenResponse,
  insufficientScopeResponse,
  invalidRequestResponse,
  libraryNotFoundResponse,
  storageFailureResponse,
} from "./errors.js";

export const librarySnapshotHandlers = HttpApiBuilder.group(
  ConsumerAuthenticatedApi,
  "librarySnapshots",
  (handlers) =>
    Effect.gen(function* () {
      const snapshots = yield* LibrarySnapshots;
      const configuration = yield* ServerConfiguration;
      const requirePrincipal = Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        if (!principal.scopes.has("library:sync"))
          return yield* Effect.fail(insufficientScopeResponse);
        return principal;
      });
      return handlers.handleAll({
        upload: ({ payload }) =>
          Effect.gen(function* () {
            const principal = yield* requirePrincipal;
            const request = yield* CurrentRequest;
            if (
              !credentialOriginAllowed(principal.credential, request, configuration.publicAppOrigin)
            )
              return yield* Effect.fail(forbiddenOriginResponse);
            return yield* snapshots.upload(principal, payload).pipe(
              Effect.catchTags({
                "Library.SnapshotArchiveInvalid": () => Effect.fail(invalidRequestResponse),
                "Cloudflare.DatabaseError": (error) =>
                  Effect.logError("snapshot database failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
                "Cloudflare.BlobStorageError": (error) =>
                  Effect.logError("snapshot blob failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
                "Library.SnapshotStoreInvalid": () => Effect.fail(storageFailureResponse),
                PlatformError: (error) =>
                  Effect.logError("snapshot digest failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
              }),
            );
          }),
        download: ({ params }) =>
          Effect.gen(function* () {
            const principal = yield* requirePrincipal;
            return yield* snapshots.download(principal, params.library_id, params.digest).pipe(
              Effect.catchTags({
                "Library.SnapshotMissing": () => Effect.fail(libraryNotFoundResponse),
                "Library.SnapshotForbidden": () => Effect.fail(forbiddenResponse),
                "Library.SnapshotArchiveInvalid": () => Effect.fail(storageFailureResponse),
                "Cloudflare.DatabaseError": (error) =>
                  Effect.logError("snapshot database failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
                "Cloudflare.BlobStorageError": (error) =>
                  Effect.logError("snapshot blob failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
                "Library.SnapshotStoreInvalid": () => Effect.fail(storageFailureResponse),
                PlatformError: (error) =>
                  Effect.logError("snapshot digest failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
              }),
            );
          }),
      });
    }),
);
