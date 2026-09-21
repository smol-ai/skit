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

const PreRenameAcceptedBase = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  libraryId: Schema.NonEmptyString,
  revisionId: Schema.NonEmptyString,
  baseManifest: Schema.Struct({ schema: Schema.Literal("skit.library.v2") }),
});

export class AcceptedBaseInvalid extends Schema.TaggedError<AcceptedBaseInvalid>()(
  "Library.AcceptedBaseInvalid",
  { path: Schema.String, detail: Schema.String },
) {}

const pathFor = (home: string) => join(resolve(home), "library-sync.json");
const preRenamePathFor = (home: string) => join(resolve(home), "portable-library-sync.json");

const readOptional = Effect.fn("Library.readOptionalAcceptedBase")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
});

const decodeAcceptedBase = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AcceptedBaseAnyVersion))(text);

/** A malformed base is an evidence error, never permission to invent a fresh ancestry. */
export const readAcceptedBaseEffect = Effect.fn("Library.readAcceptedBase")(function* (
  home: string,
) {
  const path = pathFor(home);
  const text = yield* readOptional(path);
  if (text !== undefined) {
    const decoded = yield* Effect.result(decodeAcceptedBase(text));
    if (decoded._tag === "Success") return decoded.success;
    const preRename = yield* Effect.result(
      Schema.decodeUnknownEffect(Schema.fromJsonString(PreRenameAcceptedBase))(text),
    );
    if (preRename._tag === "Failure")
      return yield* new AcceptedBaseInvalid({ path, detail: "invalid accepted sync base" });
  }
  const preRenamePath = preRenamePathFor(home);
  const preRenameText = yield* readOptional(preRenamePath);
  if (preRenameText === undefined) {
    if (text === undefined) return undefined;
    return yield* new AcceptedBaseInvalid({ path, detail: "invalid accepted sync base" });
  }
  return yield* decodeAcceptedBase(preRenameText).pipe(
    Effect.mapError(
      () => new AcceptedBaseInvalid({ path: preRenamePath, detail: "invalid accepted sync base" }),
    ),
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
