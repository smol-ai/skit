import { saveInventory, type InventoryState } from "./inventory.js";
import { saveSyncAncestry, type SyncAcceptance } from "./sync-ancestry.js";
import { saveAcceptance } from "./acceptance.js";
import type { SkillAssessmentAcceptance } from "../assessment-acceptance.js";
import { saveCatalogue, type Catalogue } from "./catalogue.js";
import { saveEnabled, type EnabledState } from "./enabled.js";
import type { InstalledSkill } from "../device-state.js";
import { loadLibraryRevision, saveInstalledSkill } from "./installed.js";
import type { Unusable } from "../machine-settings-failures.js";
import type { StalePlan } from "../plan-failures.js";
import {
  saveSetupUndo,
  recordOperation,
  saveOperation,
  settleOperation,
  type PendingOperation,
  type OperationPublication,
} from "./operations.js";
import type { OperationKind, SetupStopReason } from "./state-schema.js";
import type { Snapshot } from "../snapshot.js";
import type { LibraryAuditInvalid } from "../audit/failures.js";
import type { HistoryAction } from "./history-action.js";
import type { OperationId } from "../entity-ids.js";
import { Context, Effect, FileSystem, Option, References } from "effect";
import { Digest } from "effect/crypto";
import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import type { InvalidLibraryState, LibraryChanged, LibrarySqlError } from "../failures.js";
import type { HomeBusy } from "../../platform/lock-failures.js";
import { emptyLibraryState, type LibraryState } from "../library-state.js";
import { inspectLocalLibraryState, saveLibraryState, libraryHistoryAction } from "./state-file.js";
import { withLock as withHomeLock } from "../../platform/home-lock.js";

// Compatibility reads and the one-time import are exposed here; relational owners read their own tables.
export {
  inspectLocalLibraryState,
  migrateLocalLibraryState,
  type InspectedLibraryState,
} from "./state-file.js";

export {
  loadOperations,
  loadOperation,
  operationSummary,
  loadOperationHistory,
} from "./operations.js";

export type LibraryStateReadError =
  | PlatformError
  | InvalidLibraryState
  | LibrarySqlError
  | HomeBusy;
/** Opening a Library migrates a legacy state.json under the home lock: `HomeBusy` if held elsewhere. */
export type LibraryLayerError =
  | LibrarySqlError
  | Unusable
  | PlatformError
  | InvalidLibraryState
  | LibraryAuditInvalid
  | HomeBusy;
export type LibraryStateWriteError =
  | LibraryAuditInvalid
  | LibrarySqlError
  | Unusable
  | PlatformError
  | InvalidLibraryState
  | HomeBusy
  | LibraryChanged;

export const libraryStatePath = (home: string) => join(resolve(home), "library.sqlite");
export const libraryOriginalsPath = (home: string) => join(resolve(home), "originals");
export const libraryVariantsPath = (home: string) => join(resolve(home), "variants");

/**
 * The current state; a Library that has never been written reads as an empty one. A read never
 * writes: the Library layer migrated legacy files when it was built.
 */
export const loadLibrary = Effect.fn("Library.load")(function* (home: string) {
  const inspected = yield* inspectLocalLibraryState(home);
  return inspected.present ? inspected.state : emptyLibraryState();
});

/**
 * The one way to change Library data: present only inside `writeLibrary`, which holds the home
 * lock. Code that saves requires it, so its type says it writes.
 */
export class LibraryWriter extends Context.Service<
  LibraryWriter,
  {
    readonly home: string;
    readonly revision: Effect.Effect<number, LibraryStateWriteError>;
    readonly saveSyncAncestry: (
      request: SyncAcceptance,
    ) => Effect.Effect<void, Effect.Error<ReturnType<typeof saveSyncAncestry>>>;
    readonly saveInventory: (
      next: InventoryState,
      base: InventoryState,
      revision: number | null,
    ) => Effect.Effect<number, LibraryStateWriteError>;
    readonly saveAcceptance: (
      acceptance: SkillAssessmentAcceptance,
      revision: number,
    ) => Effect.Effect<number, LibraryStateWriteError>;
    readonly saveCatalogue: (
      next: Catalogue,
      base: Catalogue,
      revision: number | null,
    ) => Effect.Effect<number | null, LibraryStateWriteError>;
    readonly saveEnabled: (
      next: EnabledState,
      base: EnabledState,
      revision: number,
    ) => Effect.Effect<number, LibraryStateWriteError>;
    readonly saveInstalledSkill: (
      next: InstalledSkill | undefined,
      base: InstalledSkill | undefined,
      revision: number,
    ) => Effect.Effect<number, LibraryStateWriteError>;
    readonly recordOperation: (
      operation: PendingOperation,
      base: Snapshot,
      kind: OperationKind,
      replaceDone?: boolean,
    ) => Effect.Effect<void, LibraryStateWriteError | StalePlan>;
    readonly saveOperation: (
      next: PendingOperation,
      base: PendingOperation,
      state?: OperationPublication,
    ) => Effect.Effect<void, LibraryStateWriteError>;
    readonly settleOperation: (
      base: PendingOperation,
      reason?: SetupStopReason,
    ) => Effect.Effect<void, LibraryStateWriteError>;
    /** Save the inverse's domain rows, discovery and target status at the captured revision. */
    readonly saveUndo: (
      program: import("./state-schema.js").UndoProgram,
      next: LibraryState,
      base: LibraryState,
      revision: number,
    ) => Effect.Effect<void, LibraryStateWriteError>;
    /**
     * Replace `base`, a state this caller loaded, with `next`. An initialized boundary supplies
     * the revision from that same read, never a later counter. Without it, the legacy document/
     * import path verifies the stored body. A stale base saves nothing.
     */
    readonly save: (
      next: LibraryState,
      base: LibraryState,
      revision?: number,
    ) => Effect.Effect<void, LibraryStateWriteError>;
  }
>()("skit/library/LibraryWriter") {}

/** Front ends annotate their workflow; attribution carries no resource or write authority. */
const historyWorkflow = Effect.map(References.CurrentLogAnnotations, (annotations) => {
  const workflow = annotations["skit.library.workflow"];
  return typeof workflow === "string" ? workflow : "unattributed";
});

/**
 * Run `program` holding the home lock, with a `LibraryWriter` for `home`. Every change saved under
 * it accumulates in one event in the same transaction as each accepted save, because a
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
    const digest = yield* Digest.Digest;
    let live = true;
    return yield* withHomeLock(
      root,
      Effect.gen(function* () {
        const action = yield* libraryHistoryAction(root, yield* historyWorkflow, options.resume);
        // A late mutation gets a new action and home lease, including operation progress.
        const write = <A, E>(
          mutation: (
            action: HistoryAction,
          ) => Effect.Effect<A, E, FileSystem.FileSystem | Digest.Digest>,
        ) =>
          Effect.gen(function* () {
            if (live) return yield* mutation(action);
            return yield* withHomeLock(
              root,
              Effect.gen(function* () {
                return yield* mutation(yield* libraryHistoryAction(root, yield* historyWorkflow));
              }),
            );
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Digest.Digest, digest),
          );
        const writer = LibraryWriter.of({
          home: root,
          revision: loadLibraryRevision(root).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
          saveSyncAncestry: (request) => write(() => saveSyncAncestry(root, request)),
          saveInventory: (next, base, revision) =>
            write((action) => saveInventory(root, next, base, revision, action)),
          saveAcceptance: (acceptance, revision) =>
            write((action) => saveAcceptance(root, acceptance, revision, action)),
          saveCatalogue: (next, base, revision) =>
            write((action) => saveCatalogue(root, next, base, revision, action)),
          saveEnabled: (next, base, revision) =>
            write((action) => saveEnabled(root, next, base, revision, action)),
          saveInstalledSkill: (next, base, revision) =>
            write((action) => saveInstalledSkill(root, next, base, revision, action)),
          saveUndo: (program, next, base, revision) =>
            write((action) => saveSetupUndo(root, program, next, base, action, revision)),
          save: (next, base, revision) =>
            write((action) => saveLibraryState(root, next, base, action, revision)),
          recordOperation: (operation, base, kind, replaceDone = false) =>
            write((action) => recordOperation(root, operation, base, kind, action, replaceDone)),
          saveOperation: (next, base, state) =>
            write((action) => saveOperation(root, next, base, action, state)),
          settleOperation: (base, reason) =>
            write((action) => settleOperation(root, base, action, reason)),
        });
        return yield* program.pipe(Effect.provideService(LibraryWriter, writer));
      }),
    ).pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          live = false;
        }),
      ),
    );
  });
