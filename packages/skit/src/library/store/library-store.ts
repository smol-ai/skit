import { Context, DateTime, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import { InvalidLibraryState } from "../../failures.js";
import { LibraryState } from "../portable-local-state.js";
import {
  inspectLocalLibraryStateEffect,
  publishLibraryStateEffect,
  type InspectedLibraryState,
} from "./state-file.js";
import { appendLibraryAuditEffect } from "../audit/audit-log.js";
import { classifyLibraryAuditEvent, diffLibraryState } from "../audit/state-diff.js";
import { CurrentLibraryWriterRoot, withLibraryWriterLock } from "./writer-lock.js";

export type { InspectedLibraryState };

export type LibraryStateReadError = PlatformError | InvalidLibraryState;
export type LibraryStateWriteError = PlatformError | InvalidLibraryState;

export class LibraryStore extends Context.Service<
  LibraryStore,
  {
    /** The current state; a Library that has never been written reads as an empty one. */
    readonly load: Effect.Effect<LibraryState, LibraryStateReadError>;
    /** Like `load`, but tells a Library that has never been written apart from an empty one. */
    readonly inspect: Effect.Effect<InspectedLibraryState, LibraryStateReadError>;
    readonly publish: (state: LibraryState) => Effect.Effect<void, LibraryStateWriteError>;
    /** The state as history sees it; absent when it cannot be read, as before a migration. */
    readonly snapshot: Effect.Effect<LibraryState | undefined>;
    /** Append what changed since `before` to this Library's history. Reported, never raised. */
    readonly recordChangesSince: (before: LibraryState | undefined) => Effect.Effect<void>;
    readonly home: string;
    readonly originalsPath: string;
  }
>()("skit/library/LibraryStore") {}

const invalid = (path: string) => (error: unknown) =>
  new InvalidLibraryState({ path, detail: String(error) });

const emptyState = (path: string) =>
  LibraryState.makeEffect({
    schemaVersion: 4,
    collections: [],
    skills: [],
    retained_copies: [],
    acquisitions: [],
    global_bindings: [],
    local_bindings: [],
    projections: [],
    adoption_receipts: [],
    unmanaged: [],
  }).pipe(Effect.mapError(invalid(path)));

export function libraryStoreLayer(options: { home: string }) {
  return Layer.effect(
    LibraryStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = resolve(options.home);
      const path = join(home, "state.json");
      const inspect = inspectLocalLibraryStateEffect(home).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const load = Effect.flatMap(inspect, (inspected) =>
        inspected.version === 4 ? Effect.succeed(inspected.state) : emptyState(path),
      );
      const publish = Effect.fn("LibraryStore.publish")(function* (state: LibraryState) {
        yield* publishLibraryStateEffect(home, state).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      });
      const snapshot = load.pipe(
        Effect.map((state): LibraryState | undefined => state),
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      const recordChangesSince = Effect.fn("LibraryStore.recordChangesSince")(function* (
        before: LibraryState | undefined,
      ) {
        const after = yield* snapshot;
        if (before === undefined || after === undefined) return;
        const changes = diffLibraryState(before, after);
        if (changes.length === 0) return;
        const workflow = yield* LibraryActor;
        yield* appendLibraryAuditEffect(home, {
          schemaVersion: 1,
          occurredAt: DateTime.formatIso(yield* DateTime.now),
          type: classifyLibraryAuditEvent(workflow, changes),
          workflow,
          changes,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("Library changed, but history could not be recorded", cause),
          ),
        );
      });
      return {
        load,
        inspect,
        publish,
        snapshot,
        recordChangesSince,
        home,
        originalsPath: join(home, "originals"),
      };
    }),
  );
}

/**
 * Who is mutating the Library, for its history. A front end provides it once at its composition
 * root; it is a diagnostic label and not an authority, so an unlabelled mutation is still recorded.
 */
export const LibraryActor = Context.Reference<string>("skit/library/LibraryActor", {
  defaultValue: () => "unattributed",
});

/**
 * Hold the writer lock of the Library the current `LibraryStore` addresses, and record what the
 * mutation changed.
 *
 * The outermost acquisition is the transaction: history is the difference between the state it
 * found and the state it left, written on success and failure alike, because a workflow that
 * commits in stages can fail after changing the Library. Nested acquisitions are reentrant and
 * record nothing, so one action is one event however many workflows it composes. Nothing that
 * mutates the Library describes its own effect, and nothing can mutate it without leaving history.
 */
export const withLibraryWriter = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* LibraryStore;
    if ((yield* CurrentLibraryWriterRoot) === store.home) return yield* program;
    return yield* withLibraryWriterLock(
      store.home,
      Effect.gen(function* () {
        const before = yield* store.snapshot;
        return yield* program.pipe(Effect.onExit(() => store.recordChangesSince(before)));
      }),
    );
  });
