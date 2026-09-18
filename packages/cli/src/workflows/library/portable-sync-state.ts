import { PortableLibraryManifest, writeJsonAtomicEffect } from "@smolai/skit-core";
import { Effect, FileSystem, Schema } from "effect";
import { join, resolve } from "node:path";

export const PortableAcceptedBase = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  origin: Schema.NonEmptyString,
  library_id: Schema.NonEmptyString,
  revision_id: Schema.NonEmptyString,
  base_manifest: PortableLibraryManifest,
});
export type PortableAcceptedBase = typeof PortableAcceptedBase.Type;

export class PortableAcceptedBaseInvalid extends Schema.TaggedError<PortableAcceptedBaseInvalid>()(
  "Library.PortableAcceptedBaseInvalid",
  { path: Schema.String, detail: Schema.String },
) {}

const pathFor = (home: string) => join(resolve(home), "portable-library-sync.json");

/** A malformed base is an evidence error, never permission to invent a fresh ancestry. */
export const readPortableAcceptedBaseEffect = Effect.fn("Library.readPortableAcceptedBase")(
  function* (home: string) {
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
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAcceptedBase))(
      text,
    ).pipe(
      Effect.mapError(
        () => new PortableAcceptedBaseInvalid({ path, detail: "invalid accepted sync base" }),
      ),
    );
  },
);

export const publishPortableAcceptedBaseEffect = Effect.fn("Library.publishAcceptedBase")(
  function* (home: string, value: PortableAcceptedBase) {
    const path = pathFor(home);
    const verified = yield* PortableAcceptedBase.makeEffect(value).pipe(
      Effect.mapError(
        () => new PortableAcceptedBaseInvalid({ path, detail: "invalid accepted sync base" }),
      ),
    );
    yield* writeJsonAtomicEffect(path, verified);
  },
);
