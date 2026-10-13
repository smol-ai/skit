import {
  ConsumerAuthenticatedApi,
  InsufficientScopeResponse,
  LibraryNotFoundResponse,
  RevisionConflictResponse,
  UnauthorizedResponse,
  type LibraryManifest,
  type SnapshotArchive,
} from "@smolai/skit-core/universal/api";
import { Data, Effect, Schema } from "effect";
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
    new RegistryUnreachable({ origin, cause: error });
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
        ...(failure.code === undefined ? {} : { reason: failure.code }),
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
