import { LibraryActor } from "../actor.js";
import { Context, DateTime, Effect, FileSystem, Option } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import type { InvalidLibraryState, LibraryBusy, LibraryChanged } from "../../failures.js";
import { emptyLibraryState, type LibraryState } from "../library-state.js";
import { inspectLocalLibraryState, saveLibraryState } from "./state-file.js";
import { appendLibraryAudit, type LibraryAuditChange } from "../audit/audit-log.js";
import { classifyLibraryAuditEvent, diffLibraryState } from "../audit/state-diff.js";
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

/** Append one event to a Library's history. Reported, never raised: the change is durable. */
const recordLibraryHistory = Effect.fn("Library.recordHistory")(function* (
  home: string,
  changes: readonly LibraryAuditChange[],
) {
  const workflow = yield* LibraryActor;
  yield* appendLibraryAudit(home, {
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
 * Run `program` holding the home lock, with a `LibraryWriter` for `home`. Every change saved under
 * it is recorded as one history event when it ends, on success and failure alike, because a
 * workflow that commits in stages can fail after changing the Library. Inside another write to the
 * same Library it joins that write, so one action is one event however many workflows it composes.
 * A save from a fiber that outlives the write records its own event.
 */
export const writeLibrary = <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R | LibraryWriter>,
) =>
  Effect.gen(function* () {
    const root = resolve(home);
    const outer = yield* Effect.serviceOption(LibraryWriter);
    if (Option.isSome(outer) && outer.value.home === root)
      return yield* program.pipe(Effect.provideService(LibraryWriter, outer.value));
    const fs = yield* FileSystem.FileSystem;
    const changes: LibraryAuditChange[] = [];
    let live = true;
    const writer = LibraryWriter.of({
      home: root,
      save: Effect.fn("Library.save")(
        function* (next: LibraryState, base: LibraryState) {
          yield* saveLibraryState(root, next, base);
          const saved = diffLibraryState(base, next);
          if (live) changes.push(...saved);
          else if (saved.length) yield* recordLibraryHistory(root, saved);
        },
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    });
    return yield* withHomeLock(
      root,
      program.pipe(Effect.provideService(LibraryWriter, writer)),
    ).pipe(
      Effect.onExit(() => {
        live = false;
        return changes.length === 0 ? Effect.void : recordLibraryHistory(root, changes);
      }),
    );
  });
