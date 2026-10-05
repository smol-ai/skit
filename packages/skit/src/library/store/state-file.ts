// The only code that addresses `state.json` by path. Deliberately absent from the package barrel:
// workflows reach Library state through `LibraryStore`.

import { Clock, Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import { InvalidLibraryState, LibraryBusy } from "../../failures.js";
import { writeJsonAtomicEffect, writeRawAtomicEffect } from "../../platform/atomic-write.js";
import {
  decodeLibraryState,
  encodeLibraryState,
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  libraryManifestFromLocalStateEffect,
} from "../library-state.js";
import { LibraryStateV4, migrateLibraryStateFromV4 } from "./state-schema-v4.js";
import { LibraryStateV5, migrateLibraryStateFromV5 } from "./state-schema-v5.js";
import { LibraryStateV6, migrateLibraryStateFromV6 } from "./state-schema-v6.js";
import { withLibraryWriterLock } from "./writer-lock.js";

export type InspectedLibraryState =
  | { readonly present: false }
  | { readonly present: true; readonly state: LibraryState };

const StateVersion = Schema.Struct({ schemaVersion: Schema.Number });

const readStateValue = Effect.fn("Library.readStateValue")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return undefined;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new InvalidLibraryState({ path, detail: "invalid Library JSON" })),
  );
});

const decodeCurrentState = Effect.fn("Library.decodeCurrentState")(function* (
  path: string,
  value: unknown,
) {
  const state = yield* decodeLibraryState(value).pipe(
    Effect.mapError(() => new InvalidLibraryState({ path, detail: "invalid Library state" })),
  );
  yield* libraryManifestFromLocalStateEffect(state).pipe(
    Effect.mapError((error) => new InvalidLibraryState({ path, detail: String(error) })),
  );
  return state;
});

/** A legacy state document brought to the current schema; each case decodes what it reads. */
const currentFromLegacyState = Effect.fn("Library.currentFromLegacyState")(function* (
  path: string,
  version: number,
  value: unknown,
) {
  switch (version) {
    case 7:
      // v8 adds only optional sync ancestry, which a v7 document never has.
      return {
        ...(yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(
          value,
        ).pipe(
          Effect.mapError(
            () => new InvalidLibraryState({ path, detail: "invalid v7 Library state" }),
          ),
        )),
        schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
      };
    case 6:
      return migrateLibraryStateFromV6(
        yield* Schema.decodeUnknownEffect(
          Schema.Unknown.pipe(Schema.refine(Schema.is(LibraryStateV6))),
        )(value).pipe(
          Effect.mapError(
            () => new InvalidLibraryState({ path, detail: "invalid v6 Library state" }),
          ),
        ),
      );
    case 5:
      return migrateLibraryStateFromV6(
        migrateLibraryStateFromV5(
          yield* Schema.decodeUnknownEffect(
            Schema.Unknown.pipe(Schema.refine(Schema.is(LibraryStateV5))),
          )(value).pipe(
            Effect.mapError(
              () => new InvalidLibraryState({ path, detail: "invalid v5 Library state" }),
            ),
          ),
        ),
      );
    default:
      return migrateLibraryStateFromV6(
        migrateLibraryStateFromV5(
          migrateLibraryStateFromV4(
            yield* Schema.decodeUnknownEffect(
              Schema.Unknown.pipe(Schema.refine(Schema.is(LibraryStateV4))),
            )(value).pipe(
              Effect.mapError(
                () => new InvalidLibraryState({ path, detail: "invalid v4 Library state" }),
              ),
            ),
          ),
        ),
      );
  }
});

const openPresentState = Effect.fn("Library.openPresentState")(function* (
  home: string,
  path: string,
  value: unknown,
) {
  const version = yield* Schema.decodeUnknownEffect(StateVersion)(value).pipe(
    Effect.mapError(
      () => new InvalidLibraryState({ path, detail: "Library state has no schema version" }),
    ),
  );
  if (version.schemaVersion === CURRENT_LIBRARY_STATE_VERSION)
    return yield* decodeCurrentState(path, value);
  if (version.schemaVersion > CURRENT_LIBRARY_STATE_VERSION)
    return yield* new InvalidLibraryState({
      path,
      detail: `Library state schema v${version.schemaVersion} was written by a newer SKIT; this CLI supports v4–v${CURRENT_LIBRARY_STATE_VERSION}`,
    });
  if (![4, 5, 6, 7].includes(version.schemaVersion))
    return yield* new InvalidLibraryState({
      path,
      detail: `unsupported Library state schema v${version.schemaVersion}; this CLI supports v4–v${CURRENT_LIBRARY_STATE_VERSION}`,
    });
  return yield* withLibraryWriterLock(
    home,
    Effect.gen(function* () {
      const lockedValue = yield* readStateValue(path);
      if (lockedValue === undefined)
        return yield* new InvalidLibraryState({ path, detail: "Library state disappeared" });
      const lockedVersion = yield* Schema.decodeUnknownEffect(StateVersion)(lockedValue).pipe(
        Effect.mapError(
          () => new InvalidLibraryState({ path, detail: "Library state has no schema version" }),
        ),
      );
      if (lockedVersion.schemaVersion === CURRENT_LIBRARY_STATE_VERSION)
        return yield* decodeCurrentState(path, lockedValue);
      if (![4, 5, 6, 7].includes(lockedVersion.schemaVersion))
        return yield* new InvalidLibraryState({
          path,
          detail: "Library state changed while opening",
        });
      const migrated = yield* decodeCurrentState(
        path,
        yield* currentFromLegacyState(path, lockedVersion.schemaVersion, lockedValue),
      );
      // Keep the pre-migration file: migration drops history it can no longer represent.
      yield* writeJsonAtomicEffect(
        `${path}.v${lockedVersion.schemaVersion}.backup-${new Date(yield* Clock.currentTimeMillis).toISOString().replaceAll(":", "")}`,
        lockedValue,
      );
      yield* writeJsonAtomicEffect(path, migrated);
      return migrated;
    }),
  );
});

export const inspectLocalLibraryStateEffect = Effect.fn("Library.inspectState")(function* (
  home: string,
): Effect.fn.Return<
  InspectedLibraryState,
  PlatformError | InvalidLibraryState | LibraryBusy,
  FileSystem.FileSystem
> {
  const path = join(resolve(home), "state.json");
  const value = yield* readStateValue(path);
  if (value === undefined) return { present: false as const };
  return { present: true as const, state: yield* openPresentState(home, path, value) };
});

export const publishLibraryStateEffect = Effect.fn("Library.publishState")(function* (
  home: string,
  state: LibraryState,
) {
  // Encoding validates the state and serialises exactly what the loader decodes.
  const text = yield* encodeLibraryState(state).pipe(
    Effect.mapError(
      () => new InvalidLibraryState({ path: home, detail: "refusing invalid Library state" }),
    ),
  );
  yield* writeRawAtomicEffect(join(resolve(home), "state.json"), `${text}\n`);
});
