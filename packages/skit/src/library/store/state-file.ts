// The only code that addresses `state.json` by path. Deliberately absent from the package barrel:
// workflows reach Library state through `LibraryStore`.

import { Effect, FileSystem, Result, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import { InvalidLibraryState } from "../../failures.js";
import { writeJsonAtomicEffect } from "../../platform/atomic-write.js";
import {
  decodeLibraryState,
  LibraryState,
  portableManifestFromLocalStateEffect,
} from "../portable-local-state.js";

export type InspectedLibraryState =
  | { readonly version: "empty" }
  | { readonly version: 4; readonly state: LibraryState };

export const inspectLocalLibraryStateEffect = Effect.fn("Library.inspectState")(function* (
  home: string,
): Effect.fn.Return<
  InspectedLibraryState,
  PlatformError | InvalidLibraryState,
  FileSystem.FileSystem
> {
  const path = join(resolve(home), "state.json");
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return { version: "empty" as const };
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new InvalidLibraryState({ path, detail: "invalid Library JSON" })),
  );
  const current = yield* decodeLibraryState(value).pipe(Effect.result);
  if (Result.isSuccess(current)) {
    yield* portableManifestFromLocalStateEffect(current.success).pipe(
      Effect.mapError((error) => new InvalidLibraryState({ path, detail: String(error) })),
    );
    return { version: 4 as const, state: current.success };
  }
  return yield* new InvalidLibraryState({
    path,
    detail: "unsupported Library state schema",
  });
});

export const publishLibraryStateEffect = Effect.fn("Library.publishState")(function* (
  home: string,
  state: LibraryState,
) {
  const valid = yield* LibraryState.makeEffect(state).pipe(
    Effect.mapError(
      () => new InvalidLibraryState({ path: home, detail: "refusing invalid Library state" }),
    ),
  );
  yield* writeJsonAtomicEffect(join(resolve(home), "state.json"), valid);
});
