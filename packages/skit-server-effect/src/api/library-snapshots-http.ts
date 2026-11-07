import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ServerLibrary } from "../library/service.js";
import { requirePrincipalScope } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "@smolai/skit-core/api";
import {
  forbiddenResponse,
  invalidRequestResponse,
  libraryNotFoundResponse,
  storageFailureResponse,
} from "./errors.js";

export const librarySnapshotHandlers = HttpApiBuilder.group(
  ConsumerAuthenticatedApi,
  "librarySnapshots",
  (handlers) =>
    Effect.gen(function* () {
      const snapshots = (yield* ServerLibrary).snapshots;
      const requirePrincipal = requirePrincipalScope("library:sync");
      return handlers.handleAll({
        upload: ({ payload }) =>
          Effect.gen(function* () {
            const principal = yield* requirePrincipal;
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
