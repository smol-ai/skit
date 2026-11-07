import { StateEnvelope, type HistoryAction, HistoryDelivery } from "./history-delivery.js";
import { appendLibraryAudit } from "../audit/audit-log.js";
import { classifyLibraryAuditEvent, diffLibraryState } from "../audit/state-diff.js";
import { makeOperationId, OperationId } from "../entity-ids.js";
// Only this module addresses state.json. Its versioned history-delivery envelope is private;
// callers see domain snapshots through Library, without delivery bookkeeping.

import { Clock, DateTime, Effect, FileSystem, Schema, SchemaIssue } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { dirname, join, resolve } from "node:path";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { HomeBusy } from "../../platform/lock-failures.js";
import { writeJsonAtomic, writeRawAtomic, syncPaths } from "../../platform/atomic-write.js";
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
import { LibraryStateFromV9 } from "./state-schema-v9.js";
import { LibraryStateFromV10 } from "./state-schema-v10.js";
import { LibraryStateFromV11 } from "./state-schema-v11.js";
import { withLibraryStateReplacement } from "./writer-lock.js";

export type InspectedLibraryState =
  | { readonly present: false }
  | { readonly present: true; readonly state: LibraryState };

const envelope = (path: string, value: unknown) =>
  Schema.decodeUnknownEffect(StateEnvelope)(value).pipe(
    Effect.mapError(
      () => new InvalidLibraryState({ path, detail: "invalid Library storage envelope" }),
    ),
  );
const emptyDelivery = (): HistoryDelivery => ({ schemaVersion: 1, pending: [] });

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
  const { historyDelivery: _delivery, ...domain } = yield* envelope(path, value);
  const state = yield* decodeLibraryState(domain).pipe(
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
 * v4–v11 follow their historical chain directly into the current state.
 */
const OLDEST_LIBRARY_STATE_VERSION = 4;
const LegacyLibraryState = Schema.Union([
  LibraryStateFromV11,
  LibraryStateFromV10,
  LibraryStateFromV9,
  LibraryStateFromV8,
  LibraryStateFromV7,
  LibraryStateFromV6,
  LibraryStateFromV5,
  LibraryStateFromV4,
]);

const readStateVersion = (path: string, value: unknown) =>
  Schema.decodeUnknownEffect(StateVersion)(value).pipe(
    Effect.map(({ schemaVersion }) => schemaVersion),
    Effect.mapError(
      () => new InvalidLibraryState({ path, detail: "Library state has no schema version" }),
    ),
  );

const isLegacyVersion = (version: number) =>
  version >= OLDEST_LIBRARY_STATE_VERSION && version < CURRENT_LIBRARY_STATE_VERSION;

/** Decode a stored state of the current version. Any other version is refused, never migrated. */
const decodeStoredState = Effect.fn("Library.decodeStoredState")(function* (
  path: string,
  value: unknown,
) {
  const version = yield* readStateVersion(path, value);
  if (version === CURRENT_LIBRARY_STATE_VERSION) return yield* decodeCurrentState(path, value);
  if (version > CURRENT_LIBRARY_STATE_VERSION)
    return yield* new InvalidLibraryState({
      path,
      detail: `Library state schema v${version} was written by a newer SKIT; this CLI supports v${OLDEST_LIBRARY_STATE_VERSION}–v${CURRENT_LIBRARY_STATE_VERSION}`,
    });
  if (isLegacyVersion(version))
    return yield* new InvalidLibraryState({
      path,
      detail: `Library state schema v${version} has not been migrated to v${CURRENT_LIBRARY_STATE_VERSION}; run SKIT again to migrate it`,
    });
  return yield* new InvalidLibraryState({
    path,
    detail: `unsupported Library state schema v${version}; this CLI supports v${OLDEST_LIBRARY_STATE_VERSION}–v${CURRENT_LIBRARY_STATE_VERSION}`,
  });
});

/**
 * Migrate a legacy `state.json` to the current version, once, under the home lock, keeping the
 * pre-migration file as a backup. An absent file stays absent, and a file of any other version is
 * left for reads to accept or refuse. Fails with `HomeBusy` when the lock is held elsewhere.
 */
export const migrateLocalLibraryState = Effect.fn("Library.migrateState")(function* (
  home: string,
): Effect.fn.Return<void, PlatformError | InvalidLibraryState | HomeBusy, FileSystem.FileSystem> {
  const path = join(resolve(home), "state.json");
  const value = yield* readStateValue(path);
  if (value === undefined || !isLegacyVersion(yield* readStateVersion(path, value))) return;
  yield* withLibraryStateReplacement(
    home,
    Effect.gen(function* () {
      const lockedValue = yield* readStateValue(path);
      if (lockedValue === undefined) return;
      const lockedVersion = yield* readStateVersion(path, lockedValue);
      if (!isLegacyVersion(lockedVersion)) return;
      const migrated = yield* decodeCurrentState(
        path,
        yield* Schema.decodeUnknownEffect(LegacyLibraryState)(lockedValue).pipe(
          Effect.mapError(
            () =>
              new InvalidLibraryState({
                path,
                detail: `invalid v${lockedVersion} Library state`,
              }),
          ),
        ),
      );
      // Keep the pre-migration file: migration retains legacy documents that cannot safely execute.
      const backup = `${path}.v${lockedVersion}.backup-${new Date(yield* Clock.currentTimeMillis).toISOString().replaceAll(":", "")}`;
      yield* writeJsonAtomic(backup, lockedValue);
      yield* syncPaths([backup, dirname(path)]);
      yield* writeJsonAtomic(path, migrated);
      yield* syncPaths([path, dirname(path)]);
    }),
  );
});

/** Read `state.json`. Never writes and never takes the lock. */
export const inspectLocalLibraryState = Effect.fn("Library.inspectState")(function* (
  home: string,
): Effect.fn.Return<
  InspectedLibraryState,
  PlatformError | InvalidLibraryState,
  FileSystem.FileSystem
> {
  const path = join(resolve(home), "state.json");
  const value = yield* readStateValue(path);
  if (value === undefined) return { present: false as const };
  return { present: true as const, state: yield* decodeStoredState(path, value) };
});

/**
 * Replace `base` with `next`, checking and writing under the writer lock and save mutex. Fails
 * with `LibraryChanged`, writing nothing, when the Library on disk is no longer `base`.
 */
export const saveLibraryState = Effect.fn("Library.saveState")(function* (
  home: string,
  next: LibraryState,
  base: LibraryState,
  action: HistoryAction,
) {
  const path = join(resolve(home), "state.json");
  // Refuse what the loader would refuse, so a save can never strand the Library unreadable.
  const cleanNext = yield* decodeCurrentState(path, next);
  const text = yield* encodeLibraryState(cleanNext).pipe(
    Effect.mapError(
      () => new InvalidLibraryState({ path, detail: "refusing invalid Library state" }),
    ),
  );
  yield* withLibraryStateReplacement(
    home,
    Effect.gen(function* () {
      const value = yield* readStateValue(path);
      const current =
        value === undefined ? emptyLibraryState() : yield* decodeStoredState(path, value);
      if (libraryStateRevision(current) !== libraryStateRevision(base))
        return yield* new LibraryChanged({ path });
      const stored = value === undefined ? undefined : yield* envelope(path, value);
      const delivery = stored?.historyDelivery ?? emptyDelivery();
      const prior = delivery.pending.find((item) => item.event.eventId === action.eventId);
      const added = yield* Schema.decodeUnknownEffect(Schema.Array(OperationId))(
        cleanNext.operations
          .filter(
            (operation) =>
              operation._tag === "Pending" &&
              !base.operations.some((item) => item.operationId === operation.operationId),
          )
          .map((item) => item.operationId),
      ).pipe(
        Effect.mapError(
          () => new InvalidLibraryState({ path, detail: "invalid operation identity for history" }),
        ),
      );
      const changes = [...(prior?.event.changes ?? []), ...diffLibraryState(base, cleanNext)];
      let pending = delivery.pending;
      if (prior || changes.length || added.length) {
        const record = {
          event: {
            ...action,
            schemaVersion: 1 as const,
            type: classifyLibraryAuditEvent(action.workflow, changes),
            changes,
          },
          operationIds: [...new Set([...(prior?.operationIds ?? []), ...added])],
        };
        pending = prior
          ? pending.map((item) => (item === prior ? record : item))
          : [...pending, record];
      }
      // Domain state and its history draft share this single atomic replacement.
      if (pending.length) {
        const historyDelivery = yield* Schema.encodeEffect(HistoryDelivery)({
          schemaVersion: 1,
          pending,
        }).pipe(
          Effect.mapError(
            () => new InvalidLibraryState({ path, detail: "invalid history delivery record" }),
          ),
        );
        yield* writeJsonAtomic(path, { ...cleanNext, historyDelivery });
      } else yield* writeRawAtomic(path, `${text}\n`);
      yield* syncPaths([path, dirname(path)]);
    }),
  );
});

/** Reuse an interrupted operation's action identity; unrelated writes get their own identity. */
export const libraryHistoryAction = Effect.fn("Library.historyAction")(function* (
  home: string,
  workflow: string,
  resume?: OperationId,
) {
  const path = join(resolve(home), "state.json");
  const value = yield* readStateValue(path);
  if (value !== undefined && resume !== undefined) {
    const stored = yield* envelope(path, value);
    const prior = stored.historyDelivery?.pending.find((item) =>
      item.operationIds.includes(resume),
    );
    if (prior)
      return {
        eventId: prior.event.eventId,
        occurredAt: prior.event.occurredAt,
        workflow: prior.event.workflow,
      };
  }
  return {
    eventId: makeOperationId(),
    occurredAt: DateTime.formatIso(yield* DateTime.now),
    workflow,
  };
});

/** Deliver only finished actions. Pending operations retain their draft for their resumed saves. */
export const deliverLibraryHistory = Effect.fn("Library.deliverHistory")(function* (
  home: string,
  actionId?: OperationId,
) {
  const path = join(resolve(home), "state.json");
  const observed = yield* readStateValue(path);
  if (observed === undefined) return;
  const { historyDelivery } = yield* envelope(path, observed);
  if (!historyDelivery?.pending.length) return;
  // Only queued history needs the writer. Re-read under the lock before delivering anything.
  yield* withLibraryStateReplacement(
    home,
    Effect.gen(function* () {
      const value = yield* readStateValue(path);
      if (value === undefined) return;
      const { historyDelivery, ...domain } = yield* envelope(path, value);
      if (!historyDelivery?.pending.length) return;
      const state = yield* decodeStoredState(path, domain);
      const pendingIds = new Set(
        state.operations.filter((item) => item._tag === "Pending").map((item) => item.operationId),
      );
      let pending = historyDelivery.pending;
      for (const item of historyDelivery.pending) {
        if (actionId !== undefined && item.event.eventId !== actionId) continue;
        if (item.operationIds.some((id) => pendingIds.has(id))) continue;
        if (item.event.changes.length) yield* appendLibraryAudit(home, item.event);
        pending = pending.filter((record) => record !== item);
        // If delivery completed but this acknowledgement did not, the stable id deduplicates retry.
        yield* writeJsonAtomic(
          path,
          pending.length ? { ...domain, historyDelivery: { schemaVersion: 1, pending } } : domain,
        );
      }
    }),
  );
});
