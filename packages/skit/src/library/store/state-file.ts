// The only code that addresses `state.json` by path. Deliberately absent from the package barrel:
// workflows reach Library state through `LibraryStore`.

import { Clock, Effect, FileSystem, Schema, SchemaIssue } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import { InvalidLibraryState, LibraryBusy, LibraryChanged } from "../../failures.js";
import { writeJsonAtomic, writeRawAtomic } from "../../platform/atomic-write.js";
import {
  decodeLibraryState,
  encodeLibraryState,
  CURRENT_LIBRARY_STATE_VERSION,
  emptyLibraryState,
  LibraryState,
  libraryManifestFromLocalState,
  libraryStateRevision,
} from "../library-state.js";
import { LibraryStateFromV4 } from "./state-schema-v4.js";
import { LibraryStateFromV5 } from "./state-schema-v5.js";
import { LibraryStateFromV6 } from "./state-schema-v6.js";
import { LibraryStateFromV7 } from "./state-schema-v7.js";
import { LibraryStateFromV8 } from "./state-schema-v8.js";
import { withLibraryStateReplacement } from "./writer-lock.js";

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
  yield* libraryManifestFromLocalState(state).pipe(
    Effect.mapError(
      (issue) =>
        new InvalidLibraryState({
          path,
          detail: `Library state violates the portable manifest: ${SchemaIssue.makeFormatterDefault()(issue)}`,
        }),
    ),
  );
  return state;
});

/**
 * v4 is what the first public SKIT wrote. Each legacy version steps through the linear
 * v4 → v5 → v6 → v7 → v9 chain, with v8 decoded separately.
 */
const OLDEST_LIBRARY_STATE_VERSION = 4;
const LegacyLibraryState = Schema.Union([
  LibraryStateFromV8,
  LibraryStateFromV7,
  LibraryStateFromV6,
  LibraryStateFromV5,
  LibraryStateFromV4,
]);

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
      detail: `Library state schema v${version.schemaVersion} was written by a newer SKIT; this CLI supports v${OLDEST_LIBRARY_STATE_VERSION}–v${CURRENT_LIBRARY_STATE_VERSION}`,
    });
  if (version.schemaVersion < OLDEST_LIBRARY_STATE_VERSION)
    return yield* new InvalidLibraryState({
      path,
      detail: `unsupported Library state schema v${version.schemaVersion}; this CLI supports v${OLDEST_LIBRARY_STATE_VERSION}–v${CURRENT_LIBRARY_STATE_VERSION}`,
    });
  return yield* withLibraryStateReplacement(
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
      if (
        lockedVersion.schemaVersion < OLDEST_LIBRARY_STATE_VERSION ||
        lockedVersion.schemaVersion > CURRENT_LIBRARY_STATE_VERSION
      )
        return yield* new InvalidLibraryState({
          path,
          detail: "Library state changed while opening",
        });
      const migrated = yield* decodeCurrentState(
        path,
        yield* Schema.decodeUnknownEffect(LegacyLibraryState)(lockedValue).pipe(
          Effect.mapError(
            () =>
              new InvalidLibraryState({
                path,
                detail: `invalid v${lockedVersion.schemaVersion} Library state`,
              }),
          ),
        ),
      );
      // Keep the pre-migration file: migration drops history it can no longer represent.
      yield* writeJsonAtomic(
        `${path}.v${lockedVersion.schemaVersion}.backup-${new Date(yield* Clock.currentTimeMillis).toISOString().replaceAll(":", "")}`,
        lockedValue,
      );
      yield* writeJsonAtomic(path, migrated);
      return migrated;
    }),
  );
});

export const inspectLocalLibraryState = Effect.fn("Library.inspectState")(function* (
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

/**
 * Replace `base` with `next`, checking and writing under the writer lock and save mutex. Fails
 * with `LibraryChanged`, writing nothing, when the Library on disk is no longer `base`.
 */
export const saveLibraryState = Effect.fn("Library.saveState")(function* (
  home: string,
  next: LibraryState,
  base: LibraryState,
) {
  const path = join(resolve(home), "state.json");
  // Refuse what the loader would refuse, so a save can never strand the Library unreadable.
  yield* decodeCurrentState(path, next);
  const text = yield* encodeLibraryState(next).pipe(
    Effect.mapError(
      () => new InvalidLibraryState({ path, detail: "refusing invalid Library state" }),
    ),
  );
  yield* withLibraryStateReplacement(
    home,
    Effect.gen(function* () {
      const value = yield* readStateValue(path);
      const current =
        value === undefined ? emptyLibraryState() : yield* decodeCurrentState(path, value);
      if (libraryStateRevision(current) !== libraryStateRevision(base))
        return yield* new LibraryChanged({ path });
      yield* writeRawAtomic(path, `${text}\n`);
    }),
  );
});
