import {
  LibraryManifest,
  LibraryManifestAnyVersion,
  writeJsonAtomicEffect,
} from "@smolai/skit-core";
import { Effect, FileSystem, Schema } from "effect";
import { join, resolve } from "node:path";

export const AcceptedBase = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  origin: Schema.NonEmptyString,
  library_id: Schema.NonEmptyString,
  revision_id: Schema.NonEmptyString,
  base_manifest: LibraryManifest,
});
export type AcceptedBase = typeof AcceptedBase.Type;

const AcceptedBaseAnyVersion = Schema.Struct({
  ...AcceptedBase.fields,
  base_manifest: LibraryManifestAnyVersion,
});

export class AcceptedBaseInvalid extends Schema.TaggedError<AcceptedBaseInvalid>()(
  "Library.AcceptedBaseInvalid",
  { path: Schema.String, detail: Schema.String },
) {}

const pathFor = (home: string) => join(resolve(home), "library-sync.json");

/** A malformed base is an evidence error, never permission to invent a fresh ancestry. */
export const readAcceptedBaseEffect = Effect.fn("Library.readAcceptedBase")(function* (
  home: string,
) {
  const path = pathFor(home);
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return undefined;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AcceptedBaseAnyVersion))(
    text,
  ).pipe(
    Effect.mapError(() => new AcceptedBaseInvalid({ path, detail: "invalid accepted sync base" })),
  );
});

export const publishAcceptedBaseEffect = Effect.fn("Library.publishAcceptedBase")(function* (
  home: string,
  value: AcceptedBase,
) {
  const path = pathFor(home);
  const verified = yield* AcceptedBase.makeEffect(value).pipe(
    Effect.mapError(() => new AcceptedBaseInvalid({ path, detail: "invalid accepted sync base" })),
  );
  yield* writeJsonAtomicEffect(path, verified);
});
