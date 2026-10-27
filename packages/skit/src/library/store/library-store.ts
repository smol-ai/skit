import { Context, DateTime, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import type { InvalidLibraryState, LibraryBusy, LibraryChanged } from "../../failures.js";
import type { LibraryState } from "../library-state.js";
import {
  emptyLibraryStateEffect,
  inspectLocalLibraryStateEffect,
  saveLibraryStateEffect,
  type InspectedLibraryState,
} from "./state-file.js";
import { appendLibraryAuditEffect, type LibraryAuditChange } from "../audit/audit-log.js";
import { classifyLibraryAuditEvent, diffLibraryState } from "../audit/state-diff.js";
import { withLibraryWriterLock } from "./writer-lock.js";

export type { InspectedLibraryState };

export type LibraryStateReadError = PlatformError | InvalidLibraryState | LibraryBusy;
export type LibraryStateWriteError =
  | PlatformError
  | InvalidLibraryState
  | LibraryBusy
  | LibraryChanged;

export class LibraryStore extends Context.Service<
  LibraryStore,
  {
    /** The current state; a Library that has never been written reads as an empty one. */
    readonly load: Effect.Effect<LibraryState, LibraryStateReadError>;
    /** Like `load`, but tells a Library that has never been written apart from an empty one. */
    readonly inspect: Effect.Effect<InspectedLibraryState, LibraryStateReadError>;
    /**
     * Replace `base`, a state this caller loaded, with `next`. Fails with `LibraryChanged` and
     * saves nothing when the Library is no longer `base`.
     */
    readonly save: (
      next: LibraryState,
      base: LibraryState,
    ) => Effect.Effect<void, LibraryStateWriteError>;
    readonly home: string;
    readonly originalsPath: string;
    readonly statePath: string;
    readonly variantsPath: string;
  }
>()("skit/library/LibraryStore") {}

/** What the writer in progress has saved so far; it records the changes as one event. */
const CurrentLibraryAction = Context.Reference<
  | {
      readonly home: string;
      readonly changes: LibraryAuditChange[];
      saved?: LibraryState;
      live: boolean;
    }
  | undefined
>("skit/library/CurrentLibraryAction", { defaultValue: () => undefined });

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
        inspected.present ? Effect.succeed(inspected.state) : emptyLibraryStateEffect(path),
      );
      const save = Effect.fn("LibraryStore.save")(function* (
        next: LibraryState,
        base: LibraryState,
      ) {
        yield* saveLibraryStateEffect(home, next, base).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const changes = diffLibraryState(base, next);
        const action = yield* CurrentLibraryAction;
        if (action?.home === home && action.live) {
          action.saved = next;
          action.changes.push(...changes);
        } else if (changes.length)
          yield* recordLibraryHistory(home, changes).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          );
      });
      return {
        load,
        inspect,
        save,
        home,
        statePath: path,
        originalsPath: join(home, "originals"),
        variantsPath: join(home, "variants"),
      };
    }),
  );
}

/** Append one event to a Library's history. Reported, never raised: the change is durable. */
const recordLibraryHistory = Effect.fn("LibraryStore.recordHistory")(function* (
  home: string,
  changes: readonly LibraryAuditChange[],
) {
  const workflow = yield* LibraryActor;
  yield* appendLibraryAuditEffect(home, {
    schemaVersion: 1,
    occurredAt: DateTime.formatIso(yield* DateTime.now),
    type: classifyLibraryAuditEvent(workflow, changes),
    workflow,
    changes,
  }).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("Library changed, but history could not be recorded", cause),
    ),
  );
});

/**
 * Who is mutating the Library, for its history. A front end provides it once at its composition
 * root; it is a diagnostic label and not an authority, so an unlabelled mutation is still recorded.
 */
export const LibraryActor = Context.Reference<string>("skit/library/LibraryActor", {
  defaultValue: () => "unattributed",
});

/** The state the writer in progress last saved to the current Library, if it has. */
export const lastSavedLibraryState = Effect.gen(function* () {
  const store = yield* LibraryStore;
  const action = yield* CurrentLibraryAction;
  return action?.home === store.home && action.live ? action.saved : undefined;
});

/**
 * Hold the writer lock of the Library the current `LibraryStore` addresses, and record what the
 * mutation saved.
 *
 * The outermost writer is the transaction: its history is every change saved under it, written
 * as one event on success and failure alike, because a workflow that commits in stages can fail
 * after changing the Library. The event is written once the lock has drained every fiber that
 * leased it, so it includes their changes. Nested writers record nothing of their own, so one action
 * is one event however many workflows it composes; a fiber that outlives its action starts its own.
 * Nesting only groups history: every writer still enters through the lock, and each save is
 * checked against the state it was planned from.
 */
export const withLibraryWriter = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* LibraryStore;
    const inherited = yield* CurrentLibraryAction;
    if (inherited?.home === store.home && inherited.live)
      return yield* withLibraryWriterLock(store.home, program);
    const action = { home: store.home, changes: [] as LibraryAuditChange[], live: true };
    return yield* withLibraryWriterLock(
      store.home,
      program.pipe(Effect.provideService(CurrentLibraryAction, action)),
    ).pipe(
      Effect.onExit(() => {
        action.live = false;
        return action.changes.length === 0
          ? Effect.void
          : recordLibraryHistory(store.home, action.changes);
      }),
    );
  });
