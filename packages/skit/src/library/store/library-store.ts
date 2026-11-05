import type { HistoryAction } from "./history-delivery.js";
import type { OperationId } from "../entity-ids.js";
import { Context, Effect, FileSystem, Option, References } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import type { InvalidLibraryState, LibraryChanged } from "../failures.js";
import type { LibraryBusy } from "../../platform/lock-failures.js";
import { emptyLibraryState, type LibraryState } from "../library-state.js";
import {
  inspectLocalLibraryState,
  saveLibraryState,
  libraryHistoryAction,
  deliverLibraryHistory,
} from "./state-file.js";
import { withLock as withHomeLock } from "../../platform/home-lock.js";

// Reads and the one-time migration go through here too: only this module touches state-file.
export {
  inspectLocalLibraryState,
  migrateLocalLibraryState,
  type InspectedLibraryState,
} from "./state-file.js";

export type LibraryStateReadError = PlatformError | InvalidLibraryState;
/** Opening a Library migrates a legacy state.json under the home lock: `LibraryBusy` if held elsewhere. */
export type LibraryLayerError = PlatformError | InvalidLibraryState | LibraryBusy;
export type LibraryStateWriteError =
  | PlatformError
  | InvalidLibraryState
  | LibraryBusy
  | LibraryChanged;

export const libraryStatePath = (home: string) => join(resolve(home), "state.json");
export const libraryOriginalsPath = (home: string) => join(resolve(home), "originals");
export const libraryVariantsPath = (home: string) => join(resolve(home), "variants");

/**
 * The current state; a Library that has never been written reads as an empty one. A read never
 * writes: the Library layer migrated a legacy file when it was built, and a read refuses any
 * state.json that is not the current version.
 */
export const loadLibrary = Effect.fn("Library.load")(function* (home: string) {
  const inspected = yield* inspectLocalLibraryState(home);
  return inspected.present ? inspected.state : emptyLibraryState();
});

/**
 * The one way to change `state.json`: present only inside `writeLibrary`, which holds the home
 * lock. Code that saves requires it, so its type says it writes.
 */
export class LibraryWriter extends Context.Service<
  LibraryWriter,
  {
    readonly home: string;
    /**
     * Replace `base`, a state this caller loaded, with `next`. Fails with `LibraryChanged` and
     * saves nothing when the Library is no longer `base`.
     */
    readonly save: (
      next: LibraryState,
      base: LibraryState,
    ) => Effect.Effect<void, LibraryStateWriteError>;
  }
>()("skit/library/LibraryWriter") {}

/** Front ends annotate their workflow; attribution carries no resource or write authority. */
const historyWorkflow = Effect.map(References.CurrentLogAnnotations, (annotations) => {
  const workflow = annotations["skit.library.workflow"];
  return typeof workflow === "string" ? workflow : "unattributed";
});

/** Retry is safe: undelivered events remain in the same durable file as the Library state. */
export const recoverLibraryHistory = (home: string, actionId?: OperationId) =>
  deliverLibraryHistory(home, actionId).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Library history delivery is pending", cause)),
  );

/**
 * Run `program` holding the home lock, with a `LibraryWriter` for `home`. Every change saved under
 * it is recorded as one history event when it ends, on success and failure alike, because a
 * workflow that commits in stages can fail after changing the Library. Inside another write to the
 * same Library it joins that write, so one action is one event however many workflows it composes.
 * A save from a fiber that outlives the write records its own event.
 */
export const writeLibrary = <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R | LibraryWriter>,
  options: { readonly resume?: OperationId } = {},
) =>
  Effect.gen(function* () {
    const root = resolve(home);
    const outer = yield* Effect.serviceOption(LibraryWriter);
    if (Option.isSome(outer) && outer.value.home === root && options.resume === undefined)
      return yield* program.pipe(Effect.provideService(LibraryWriter, outer.value));
    const fs = yield* FileSystem.FileSystem;
    let live = true;
    let currentAction: HistoryAction | undefined;
    return yield* withHomeLock(
      root,
      Effect.gen(function* () {
        const action = yield* libraryHistoryAction(root, yield* historyWorkflow, options.resume);
        currentAction = action;
        const writer = LibraryWriter.of({
          home: root,
          save: Effect.fn("Library.save")(
            function* (next: LibraryState, base: LibraryState) {
              if (live) return yield* saveLibraryState(root, next, base, action);
              // An escaped writer cannot extend an action that already delivered its event.
              let late: HistoryAction | undefined;
              yield* withHomeLock(
                root,
                Effect.gen(function* () {
                  late = yield* libraryHistoryAction(root, yield* historyWorkflow);
                  yield* saveLibraryState(root, next, base, late);
                }),
              ).pipe(
                Effect.onExit(() =>
                  late ? recoverLibraryHistory(root, late.eventId) : Effect.void,
                ),
              );
            },
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        });
        return yield* program.pipe(Effect.provideService(LibraryWriter, writer));
      }),
    ).pipe(
      Effect.onExit(() => {
        // withHomeLock has drained the save leases, so the whole action's draft is now final.
        live = false;
        return currentAction ? recoverLibraryHistory(root, currentAction.eventId) : Effect.void;
      }),
    );
  });
