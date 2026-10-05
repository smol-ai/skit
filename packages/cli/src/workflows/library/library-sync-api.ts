import {
  ConsumerAuthenticatedApi,
  InsufficientScopeResponse,
  LibraryNotFoundResponse,
  RevisionConflictResponse,
  UnauthorizedResponse,
  type LibraryManifest,
  type SnapshotArchive,
} from "@smolai/skit-core/universal/api";
import { Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { LibraryWriteRequest } from "@smolai/skit-core/universal/consumer";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  LibraryChangedOnServer,
} from "../../registry/failures.js";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  registryApiFailure,
} from "../../registry/api-client.js";
import {
  isRegistryTransportError,
  RegistryHttp,
  RegistryTransportError,
} from "../../registry/registry-http.js";

export class LibraryApiUnreachable extends Schema.TaggedError<LibraryApiUnreachable>()(
  "Library.LibraryApiUnreachable",
  { origin: Schema.String, cause: Schema.Defect() },
) {}
export class LibraryApiRejected extends Schema.TaggedError<LibraryApiRejected>()(
  "Library.LibraryApiRejected",
  { status: Schema.Number, code: Schema.optionalKey(Schema.String) },
) {}
export class LibraryApiInvalidResponse extends Schema.TaggedError<LibraryApiInvalidResponse>()(
  "Library.LibraryApiInvalidResponse",
  { operation: Schema.String },
) {}
/** The remote Library is in a wire format this CLI can read but cannot merge with. */
export class LibraryRemoteUnsupported extends Schema.TaggedError<LibraryRemoteUnsupported>()(
  "Library.LibraryRemoteUnsupported",
  { revision_id: Schema.String },
) {}
export class LibraryApiInvalidRequest extends Schema.TaggedError<LibraryApiInvalidRequest>()(
  "Library.LibraryApiInvalidRequest",
  {},
) {}

/** All private Library requests use one generated client in the caller's scope. */
export const librarySyncApiEffect = Effect.fn("Library.librarySyncApi")(function* (options: {
  origin: string;
  token?: string;
}) {
  const origin = options.origin.replace(/\/$/, "");
  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(ConsumerAuthenticatedApi, {
    httpClient: transport,
    baseUrl: origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(options.token)));
  const transportFailure = (error: RegistryTransportError) =>
    new LibraryApiUnreachable({ origin, cause: new Error(error.message, { cause: error }) });
  const invalidResponse = (operation: string) => new LibraryApiInvalidResponse({ operation });
  const mapGeneratedFailure = (operation: string, error: unknown) => {
    if (isRegistryTransportError(error)) return transportFailure(error);
    if (Schema.is(UnauthorizedResponse)(error)) return new AuthenticationRequired({});
    if (Schema.is(InsufficientScopeResponse)(error))
      return new CredentialLacksScope({ scope: "library:sync" });
    if (isSuccessfulResponseDecodeFailure(error, [200])) return invalidResponse(operation);
    const failure = registryApiFailure(error);
    if (failure.status !== undefined)
      return new LibraryApiRejected({
        status: failure.status,
        ...(failure.code === undefined ? {} : { code: failure.code }),
      });
    return invalidResponse(operation);
  };
  const read = Effect.fn("Library.librarySyncApi.read")(function* () {
    return yield* client.librarySync.read({}).pipe(
      Effect.catch((error) => {
        return Schema.is(LibraryNotFoundResponse)(error)
          ? Effect.succeed(null)
          : Effect.fail(mapGeneratedFailure("read portable Library", error));
      }),
      // Every supported wire version decodes to the current manifest; v2 has no such migration.
      Effect.flatMap((response) => {
        if (response === null) return Effect.succeed(null);
        const { library_id, revision_id, manifest } = response.library;
        return manifest.schema === "skit.library.v2"
          ? Effect.fail(new LibraryRemoteUnsupported({ revision_id }))
          : Effect.succeed({ library_id, revision_id, manifest });
      }),
    );
  });
  const upload = Effect.fn("Library.librarySyncApi.upload")(function* (archive: SnapshotArchive) {
    return yield* client.librarySnapshots
      .upload({ payload: archive })
      .pipe(Effect.mapError((error) => mapGeneratedFailure("upload private snapshot", error)));
  });
  const write = Effect.fn("Library.librarySyncApi.write")(function* (
    expected_revision_id: string | null,
    manifest: LibraryManifest,
  ) {
    const request = yield* LibraryWriteRequest.makeEffect({
      expected_revision_id,
      manifest,
    }).pipe(Effect.mapError(() => new LibraryApiInvalidRequest()));
    return yield* client.librarySync.write({ payload: request }).pipe(
      Effect.map((response) => response.library),
      Effect.mapError((error) => {
        return Schema.is(RevisionConflictResponse)(error)
          ? new LibraryChangedOnServer()
          : mapGeneratedFailure("write portable Library", error);
      }),
    );
  });
  const download = Effect.fn("Library.librarySyncApi.download")(function* (
    libraryId: string,
    digest: string,
  ) {
    return yield* client.librarySnapshots
      .download({
        params: { library_id: libraryId, digest },
      })
      .pipe(Effect.mapError((error) => mapGeneratedFailure("download private snapshot", error)));
  });
  return { read, upload, write, download };
});
