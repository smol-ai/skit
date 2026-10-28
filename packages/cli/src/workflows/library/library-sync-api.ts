import {
  ConsumerAuthenticatedApi,
  CURRENT_PORTABLE_LIBRARY_SCHEMA,
  InsufficientScopeResponse,
  LibraryNotFoundResponse,
  RevisionConflictResponse,
  UnauthorizedResponse,
  type LibraryManifest,
  type SnapshotArchive,
} from "@smolai/skit-core/universal/api";
import { Data, Effect, Option, Predicate, Schema } from "effect";
import { HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { LibraryWriteRequest } from "@smolai/skit-core/universal/consumer";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  LibraryChangedOnServer,
  RegistryUnreachable,
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
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class LibraryApiRejected
  extends Data.TaggedError("Library.LibraryApiRejected")<{
    status: number;
    reason?: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Check the Registry's reason and the active credential, then run `skit sync` again.";
  get message(): string {
    return `The Registry rejected the Library request (${this.status})${this.reason === undefined ? "" : `: ${this.reason}`}`;
  }
}
export class LibraryApiInvalidResponse
  extends Data.TaggedError("Library.LibraryApiInvalidResponse")<{
    operation: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check that the Registry runs a compatible SKIT server, then retry.";
  get message(): string {
    return `The Registry returned an invalid ${this.operation} response`;
  }
}
export class LibraryManifestTooNew
  extends Data.TaggedError("Library.LibraryManifestTooNew")<{
    observed: string;
    supported: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Upgrade SKIT, then run `skit sync` again.";
  get message(): string {
    return `The Registry's Library is ${this.observed}, written by a newer SKIT; this CLI supports ${this.supported}`;
  }
}
export class LibraryApiInvalidRequest
  extends Data.TaggedError("Library.LibraryApiInvalidRequest")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the Library, then run `skit sync` again.";
  get message(): string {
    return "The Library could not be encoded as a Registry request";
  }
}

/** All private Library requests use one generated client in the caller's scope. */
export const librarySyncApi = Effect.fn("Library.librarySyncApi")(function* (options: {
  origin: string;
  token?: string;
}) {
  const origin = options.origin.replace(/\/$/, "");
  const transport = yield* (yield* RegistryHttp).client;
  // A Library head is decoded only as the manifest schema this CLI supports, which would read a
  // newer one as malformed. Its schema discriminator is read first, from the raw body, so a head a
  // newer SKIT wrote is refused as such before sync reads or writes anything else.
  const client = yield* HttpApiClient.makeWith(ConsumerAuthenticatedApi, {
    httpClient: HttpClient.transformResponse(
      transport,
      Effect.tap((response) =>
        Effect.gen(function* () {
          if (
            response.status !== 200 ||
            new URL(response.request.url).pathname !== "/api/library/portable"
          )
            return;
          const head = yield* response.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  library: Schema.Struct({ manifest: Schema.Struct({ schema: Schema.String }) }),
                }),
              ),
            ),
            Effect.option,
          );
          // A missing, foreign or older schema is left to the full decode, which rejects it.
          if (Option.isNone(head)) return;
          const { schema } = head.value.library.manifest;
          const version = /^skit\.library\.v(\d+)$/.exec(schema)?.[1];
          if (
            version !== undefined &&
            Number(version) > Number(CURRENT_PORTABLE_LIBRARY_SCHEMA.slice("skit.library.v".length))
          )
            return yield* new LibraryManifestTooNew({
              observed: schema,
              supported: CURRENT_PORTABLE_LIBRARY_SCHEMA,
            });
        }),
      ),
    ),
    baseUrl: origin,
  }).pipe(Effect.provide(authenticatedApiMiddleware(options.token)));
  const transportFailure = (error: RegistryTransportError) =>
    new RegistryUnreachable({ origin, cause: error });
  const invalidResponse = (operation: string) => new LibraryApiInvalidResponse({ operation });
  const mapGeneratedFailure = (operation: string, error: unknown) => {
    if (isRegistryTransportError(error)) return transportFailure(error);
    if (Schema.is(UnauthorizedResponse)(error)) return new AuthenticationRequired({ origin });
    if (Schema.is(InsufficientScopeResponse)(error))
      return new CredentialLacksScope({ scope: "library:sync" });
    if (isSuccessfulResponseDecodeFailure(error, [200])) return invalidResponse(operation);
    const failure = registryApiFailure(error);
    if (failure.status !== undefined)
      return new LibraryApiRejected({
        status: failure.status,
        ...(failure.code === undefined ? {} : { reason: failure.code }),
      });
    return invalidResponse(operation);
  };
  const read = Effect.fn("Library.librarySyncApi.read")(function* () {
    return yield* client.librarySync.read({}).pipe(
      Effect.catch((error) => {
        return Schema.is(LibraryNotFoundResponse)(error)
          ? Effect.succeed(null)
          : Effect.fail(
              Predicate.isTagged(error, "Library.LibraryManifestTooNew")
                ? error
                : mapGeneratedFailure("read portable Library", error),
            );
      }),
      Effect.map((response) => (response === null ? null : response.library)),
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
        if (Predicate.isTagged(error, "Library.LibraryManifestTooNew")) return error;
        return Schema.is(RevisionConflictResponse)(error)
          ? new LibraryChangedOnServer()
          : mapGeneratedFailure("write portable Library", error);
      }),
    );
  });
  const download = Effect.fn("Library.librarySyncApi.download")(function* (
    libraryId: string,
    hash: string,
  ) {
    return yield* client.librarySnapshots
      .download({
        params: { library_id: libraryId, digest: hash },
      })
      .pipe(Effect.mapError((error) => mapGeneratedFailure("download private snapshot", error)));
  });
  return { read, upload, write, download };
});
