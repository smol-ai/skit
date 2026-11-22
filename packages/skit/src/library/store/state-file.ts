import { LibraryStateFields } from "./state-fields.js";
import { canonicalJson } from "../../shared/json.js";
import type { HistoryAction } from "./history-action.js";
import { classifyLibraryAuditEvent, diffLibraryState } from "../audit/state-diff.js";
import { makeOperationId, OperationId } from "../entity-ids.js";
// This loader alone reads legacy state.json/audit.jsonl. Current state, operation rows and
// audit events share a database transaction; callers see the same domain snapshot.
import { DateTime, Effect, FileSystem, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Digest } from "effect/crypto";
import { sha256Hash } from "../../shared/hash.js";
import {
  currentLibraryTransaction,
  libraryDatabasePath,
  prepareLibraryDatabase,
  withDatabaseTransaction,
  withLibraryDatabase,
} from "./database.js";
import { LibraryAuditEvent } from "../audit/contracts.js";
import { LibraryAuditInvalid } from "../audit/failures.js";

import type { PlatformError } from "effect/PlatformError";
import { join, resolve } from "node:path";
import { InvalidLibraryState, LibraryChanged, LibrarySqlError } from "../failures.js";
import { HomeBusy } from "../../platform/lock-failures.js";
import { writeRawAtomic, syncPaths } from "../../platform/atomic-write.js";
import {
  decodeLibraryState,
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
import { OperationStatus } from "./state-schema.js";
import { withLibraryStateReplacement } from "./writer-lock.js";

import { CurrentSetupOperation, prepareSetupProgress, SetupIntent } from "./setup-intent.js";
import { setupIntent } from "./intent.js";

import { loadLibraryRows, saveLibraryRows } from "./rows.js";
import { JsonObject } from "../../shared/json.js";

export type InspectedLibraryState =
  | { readonly present: false }
  | { readonly present: true; readonly state: LibraryState; readonly revision: number };

/** Validate the known audit fields without projecting away stored extensions. */
const StoredAuditEvent = Schema.declare(
  (value: unknown): value is LibraryAuditEvent =>
    Schema.is(JsonObject)(value) && Schema.is(LibraryAuditEvent)(value),
);

// oxlint-disable-next-line effecttsgo/schema-number -- Preserve numeric future-version diagnostics, including overflow.
const StateVersion = Schema.Struct({ schemaVersion: Schema.Number });

export const decodeCurrentState = Effect.fn("Library.decodeCurrentState")(function* (
  path: string,
  value: unknown,
) {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct(LibraryStateFields), {
    onExcessProperty: "error",
  })(value).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  const state = yield* decodeLibraryState(decoded).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  yield* libraryManifestFromLocalState(state).pipe(
    Effect.mapError(
      (issue) =>
        new InvalidLibraryState({
          path,
          reason: { _tag: "SchemaInvalid", failure: new Schema.SchemaError(issue) },
        }),
    ),
  );
  return state;
});

/**
 * v4 is what the first public SKIT wrote. Each legacy version steps through the linear
 * v4–v9 are the released source formats.
 */
const OLDEST_LIBRARY_STATE_VERSION = 4;
const NEWEST_LIBRARY_STATE_FILE_VERSION = 9;
const LegacyLibraryState = Schema.Union([
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
      () =>
        new InvalidLibraryState({
          path,
          reason: {
            _tag: "UnsupportedVersion",
            oldest: OLDEST_LIBRARY_STATE_VERSION,
            current: CURRENT_LIBRARY_STATE_VERSION,
          },
        }),
    ),
  );

const isLegacyVersion = (version: number) =>
  Number.isInteger(version) &&
  version >= OLDEST_LIBRARY_STATE_VERSION &&
  version <= NEWEST_LIBRARY_STATE_FILE_VERSION;

/** Decode a stored state of the current version. Any other version is refused, never migrated. */
const decodeStoredState = Effect.fn("Library.decodeStoredState")(function* (
  path: string,
  value: unknown,
) {
  const version = yield* readStateVersion(path, value);
  if (version === CURRENT_LIBRARY_STATE_VERSION) return yield* decodeCurrentState(path, value);
  // Newer, not yet migrated, or unknown: the numbers say which. A version too large to hold is
  // still newer, so it is kept at the largest number there is.
  return yield* new InvalidLibraryState({
    path,
    reason: {
      _tag: "UnsupportedVersion",
      version: Math.max(-Number.MAX_VALUE, Math.min(version, Number.MAX_VALUE)),
      oldest: OLDEST_LIBRARY_STATE_VERSION,
      current: CURRENT_LIBRARY_STATE_VERSION,
    },
  });
});

/** One SQL snapshot and one loader validation of the assembled current state. */
export const readDatabaseState = Effect.fn("Library.readDatabaseState")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const loaded = yield* loadLibraryRows(path);
      if (loaded === undefined) {
        const operations = yield* sql`SELECT operation_id FROM library_operations LIMIT 1`;
        if (operations.length)
          return yield* new InvalidLibraryState({
            path,
            reason: { _tag: "OperationStateMissing", databasePath: path },
          });
        return { state: undefined, revision: null };
      }
      const state = yield* decodeStoredState(path, loaded.value);
      return { state, revision: loaded.revision };
    }),
  );
});

/** Read transaction freshness without loading Library values. */
export const readDatabaseStateRevision = Effect.fn("Library.readDatabaseStateRevision")(function* (
  path: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    revision: number;
  }>`SELECT revision FROM library_device WHERE id = 1`;
  if (rows[0]) return { revision: rows[0].revision };
  if ((yield* sql`SELECT operation_id FROM library_operations LIMIT 1`).length)
    return yield* new InvalidLibraryState({
      path,
      reason: { _tag: "OperationStateMissing", databasePath: path },
    });
  return { revision: null };
});

/** The caller owns the transaction, including all row and audit changes. */
export const advanceLibraryRevision = Effect.fn("Library.advanceRevision")(function* (
  path: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    revision: number;
  }>`UPDATE library_device SET revision=revision+1 WHERE id=1 RETURNING revision`;
  if (!rows[0]) return yield* new LibraryChanged({ path });
  return rows[0].revision;
});

const libraryJson = Effect.fn("Library.stateJson")(function* (path: string, state: LibraryState) {
  const value = yield* Effect.try({
    try: () => JSON.stringify(state),
    catch: () =>
      new InvalidLibraryState({
        path,
        reason: { _tag: "DocumentEncodingFailed", document: "library" },
      }),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(value).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
});

/** Validate the JSON to be saved once, then write changed rows in the caller's transaction. */
export const saveDatabaseState = Effect.fn("Library.saveDatabaseState")(function* (
  path: string,
  next: LibraryState,
  base: LibraryState | null,
  revision?: number,
) {
  // Sync already assembled its boundary value under the home lock. Its counter establishes
  // freshness without loading that value a second time; legacy import still checks its document.
  let current: { state: LibraryState | undefined; revision: number | null };
  if (revision === undefined) current = yield* readDatabaseState(path);
  else {
    const saved = yield* readDatabaseStateRevision(path);
    if (saved.revision !== revision || base === null) return yield* new LibraryChanged({ path });
    current = { state: base, revision: saved.revision };
  }
  const before = base === null ? undefined : yield* libraryJson(path, base);
  const baseState = before === undefined ? undefined : yield* decodeCurrentState(path, before);
  if (
    revision === undefined &&
    (baseState === undefined
      ? current.state !== undefined
      : libraryStateRevision(current.state ?? emptyLibraryState()) !==
        libraryStateRevision(baseState))
  )
    return yield* new LibraryChanged({ path });
  const document = yield* libraryJson(path, next);
  const state = yield* decodeCurrentState(path, document);
  const savedState = revision === undefined ? current.state : baseState;
  if (savedState !== undefined && libraryStateRevision(state) === libraryStateRevision(savedState))
    return state;
  const normalized = yield* Schema.decodeUnknownEffect(JsonObject)(state).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  yield* saveLibraryRows(normalized, current.revision === null ? undefined : before).pipe(
    Effect.catchTag("SchemaError", (failure) =>
      Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
    ),
  );
  yield* advanceLibraryRevision(path);
  if (base !== null) yield* saveSetupIntentProgress(path, setupIntent(base), setupIntent(state));
  return state;
});

/** Selection writes and document imports update the active setup's scope history identically. */
export const saveSetupIntentProgress = Effect.fn("Library.saveSetupIntentProgress")(function* (
  path: string,
  before: SetupIntent,
  after: SetupIntent,
) {
  const active = yield* CurrentSetupOperation;
  if (active !== undefined) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      document: string;
    }>`SELECT document FROM library_operations WHERE operation_id=${active}`;
    if (rows[0]) {
      const operation = yield* Schema.decodeEffect(Schema.fromJsonString(OperationStatus))(
        rows[0].document,
      ).pipe(
        Effect.mapError(
          (failure) =>
            new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
        ),
      );
      if (operation._tag === "Pending" && operation.setup) {
        const changes = yield* prepareSetupProgress(operation.setup.changes, before, after, path);
        const document = yield* Schema.encodeEffect(Schema.fromJsonString(OperationStatus))({
          ...operation,
          setup: { ...operation.setup, changes },
        }).pipe(
          Effect.mapError(
            (failure) =>
              new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
          ),
        );
        yield* sql`UPDATE library_operations SET document=${document} WHERE operation_id=${active}`;
      }
    }
  }
});

/** Each accepted state/progress write accumulates its event in the same transaction. */
export const saveLibraryHistory = Effect.fn("Library.saveHistory")(function* (
  path: string,
  action: HistoryAction,
  changes: readonly LibraryAuditEvent["changes"][number][],
  operationIds: readonly OperationId[] = [],
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ document: string; operation_ids: string }>`
    SELECT document, operation_ids FROM library_audit_events WHERE event_id = ${action.eventId}`;
  const prior =
    rows[0] === undefined
      ? undefined
      : yield* Schema.decodeEffect(Schema.fromJsonString(StoredAuditEvent))(rows[0].document).pipe(
          Effect.mapError(
            (failure) =>
              new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
          ),
        );
  const ids =
    rows[0] === undefined
      ? []
      : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(OperationId)))(
          rows[0].operation_ids,
        ).pipe(
          Effect.mapError(
            (failure) =>
              new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
          ),
        );
  const combined = [...(prior?.changes ?? []), ...changes];
  if (!prior && !combined.length && !operationIds.length) return;
  const event: LibraryAuditEvent = {
    ...prior,
    ...action,
    schemaVersion: 1,
    type: classifyLibraryAuditEvent(action.workflow, combined),
    changes: combined,
  };
  yield* sql`INSERT INTO library_audit_events (event_id, document, operation_ids)
    VALUES (${action.eventId}, ${JSON.stringify(event)}, ${JSON.stringify([...new Set([...ids, ...operationIds])])})
    ON CONFLICT (event_id) DO UPDATE SET document = excluded.document, operation_ids = excluded.operation_ids`;
});

const readLegacyText = Effect.fn("Library.readLegacyText")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(path)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
});

const readLegacyHash = Effect.fn("Library.readLegacyHash")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs
    .readFile(path)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
  return bytes === undefined ? null : yield* sha256Hash(bytes);
});

const databaseImportOwner = "skit-library-database-import\n";
const databaseStub = `${JSON.stringify({ schemaVersion: CURRENT_LIBRARY_STATE_VERSION + 1 }, null, 2)}\n`;

/** Only the Library's import may replace state.json with the old-reader refusal. */
const finishDatabaseImport = Effect.fn("Library.finishDatabaseImport")(function* (home: string) {
  const path = libraryDatabasePath(home);
  const source = join(home, "state.json");
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{
        hash: string | null;
        backup: string | null;
        fenced: number;
      }>`SELECT hash,backup,fenced FROM library_import WHERE source='state.json'`)[0];
      if (!row) return false;
      const text = yield* readLegacyText(source);
      if (text !== databaseStub) {
        if (row.fenced === 1 && text !== undefined)
          return yield* new InvalidLibraryState({
            path: source,
            reason: { _tag: "LegacyStateBesideDatabase", statePath: source, databasePath: path },
          });
        if (row.fenced === 0 && (yield* readLegacyHash(source)) !== row.hash)
          return yield* new InvalidLibraryState({
            path: source,
            reason: {
              _tag: "LegacySourceChanged",
              sourcePath: source,
              backupPath: row.backup,
              databasePath: path,
            },
          });
        yield* writeRawAtomic(source, databaseStub);
        yield* syncPaths([source, home]);
      }
      if (row.fenced === 0)
        yield* sql`UPDATE library_import SET fenced=1 WHERE source='state.json'`;
      return true;
    }),
  );
});

/** Each legacy file imports only its own data, with its own source hash and refusal. */
export const migrateLocalLibraryState = Effect.fn("Library.migrateState")(function* (
  home: string,
  create = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(home);
  const path = libraryDatabasePath(root);
  const statePath = join(root, "state.json"),
    auditPath = join(root, "audit.jsonl");
  const stateText = yield* readLegacyText(statePath),
    auditText = yield* readLegacyText(auditPath);
  if (!(yield* fs.exists(path))) {
    const owner = yield* readLegacyText(join(root, ".lock"));
    if (owner !== undefined && owner !== databaseImportOwner)
      return yield* new HomeBusy({ path: join(root, ".lock"), owner });
  }
  if (
    !(yield* prepareLibraryDatabase(
      root,
      create || stateText !== undefined || auditText !== undefined,
    ))
  )
    return;
  const lockPath = join(root, ".lock");
  const pendingImport = (stateText: string | undefined, auditText: string | undefined) =>
    Effect.gen(function* () {
      const records = yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            source: string;
            hash: string | null;
            backup: string | null;
            fenced: number;
          }>`SELECT source,hash,backup,fenced FROM library_import WHERE source IN ('state.json','audit.jsonl')`;
        }),
        true,
      );
      const prior = records.find((row) => row.source === "state.json"),
        audit = records.find((row) => row.source === "audit.jsonl");
      const auditHash =
        auditText === undefined ? null : yield* sha256Hash(new TextEncoder().encode(auditText));
      if (audit && auditText !== undefined && audit.hash !== auditHash)
        return yield* new InvalidLibraryState({
          path: auditPath,
          reason: {
            _tag: "LegacySourceChanged",
            sourcePath: auditPath,
            backupPath: audit.backup,
            databasePath: path,
          },
        });
      if (prior?.fenced === 1 && stateText !== undefined && stateText !== databaseStub)
        return yield* new InvalidLibraryState({
          path: statePath,
          reason: { _tag: "LegacyStateBesideDatabase", statePath, databasePath: path },
        });
      const needsState =
        prior === undefined
          ? stateText !== undefined || create
          : prior.fenced === 0 || stateText !== databaseStub;
      const needsAudit =
        audit === undefined &&
        (auditText !== undefined || stateText !== undefined || prior !== undefined || create);
      if (!needsState && !needsAudit && (yield* readLegacyText(lockPath)) !== databaseImportOwner)
        return undefined;
      return { prior, needsState };
    });
  // The unlocked probe can skip a completed import. Only the locked read may reject it.
  const ready = yield* pendingImport(stateText, auditText).pipe(
    Effect.map((pending) => pending === undefined),
    Effect.catchTag("InvalidLibraryState", () => Effect.succeed(false)),
  );
  if (ready) return;
  if (yield* currentLibraryTransaction(root))
    return yield* new InvalidLibraryState({
      path,
      reason: {
        _tag: "ImportInsideTransaction",
      },
    });
  yield* withLibraryStateReplacement(
    root,
    Effect.gen(function* () {
      const pending = yield* pendingImport(
        yield* readLegacyText(statePath),
        yield* readLegacyText(auditPath),
      );
      if (!pending) return;
      const { prior, needsState } = pending;
      let locked = false;
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            yield* writeRawAtomic(lockPath, databaseImportOwner, true).pipe(
              Effect.catchReason("PlatformError", "AlreadyExists", () =>
                Effect.gen(function* () {
                  const owner = yield* readLegacyText(lockPath);
                  if (owner !== databaseImportOwner)
                    return yield* new HomeBusy({ path: lockPath, owner: owner ?? "unknown" });
                }),
              ),
            );
            locked = true;
            yield* syncPaths([lockPath, root]);
            yield* withLibraryDatabase(
              path,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const row = (yield* sql<{
                  hash: string | null;
                  backup: string | null;
                }>`SELECT hash,backup FROM library_import WHERE source='audit.jsonl'`)[0];
                const text = yield* readLegacyText(auditPath);
                const hash =
                  text === undefined ? null : yield* sha256Hash(new TextEncoder().encode(text));
                if (row) {
                  if (text !== undefined && hash !== row.hash)
                    return yield* new InvalidLibraryState({
                      path: auditPath,
                      reason: {
                        _tag: "LegacySourceChanged",
                        sourcePath: auditPath,
                        backupPath: row.backup,
                        databasePath: path,
                      },
                    });
                  return;
                }
                if (text === undefined && !create && !needsState && prior === undefined) return;
                const events: LibraryAuditEvent[] = [];
                if (text !== undefined) {
                  const lines = text.split("\n");
                  for (const [index, line] of lines.entries()) {
                    if (!line && index === lines.length - 1) continue;
                    events.push(
                      yield* Schema.decodeEffect(Schema.fromJsonString(StoredAuditEvent))(
                        line,
                      ).pipe(
                        Effect.mapError(
                          (failure) =>
                            new LibraryAuditInvalid({
                              path: auditPath,
                              line: index + 1,
                              reason: { _tag: "SchemaInvalid", failure },
                            }),
                        ),
                      ),
                    );
                  }
                }
                const backup = text === undefined ? null : `${auditPath}.backup-database`;
                if (backup !== null && text !== undefined) {
                  const saved = yield* readLegacyText(backup);
                  if (saved !== undefined && saved !== text)
                    return yield* new InvalidLibraryState({
                      path: backup,
                      reason: {
                        _tag: "ImportBackupChanged",
                        sourcePath: auditPath,
                        backupPath: backup,
                        databasePath: path,
                      },
                    });
                  if (saved === undefined) yield* writeRawAtomic(backup, text, true);
                  yield* syncPaths([backup, root]);
                }
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    for (const event of events) {
                      const existing = (yield* sql<{
                        document: string;
                      }>`SELECT document FROM library_audit_events WHERE event_id=${event.eventId}`)[0];
                      if (existing) {
                        const expected = yield* Schema.decodeEffect(
                          Schema.fromJsonString(StoredAuditEvent),
                        )(existing.document).pipe(
                          Effect.mapError(
                            (failure) =>
                              new LibraryAuditInvalid({
                                path: auditPath,
                                reason: { _tag: "SchemaInvalid", failure },
                              }),
                          ),
                        );
                        if (canonicalJson(expected) !== canonicalJson(event))
                          return yield* new LibraryAuditInvalid({
                            path: auditPath,
                            reason: {
                              _tag: "EventIdentityChanged",
                              eventId: event.eventId,
                              expected,
                              actual: event,
                            },
                          });
                      } else
                        yield* sql`INSERT INTO library_audit_events (event_id,document) VALUES (${event.eventId},${canonicalJson(event)})`;
                    }
                    yield* sql`INSERT INTO library_import (source,backup,hash,fenced) VALUES ('audit.jsonl',${backup},${hash},1)`;
                  }),
                );
              }),
            );
            yield* withLibraryDatabase(
              path,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const registered =
                  (yield* sql`SELECT source FROM library_import WHERE source='state.json'`).length >
                  0;
                if (needsState && !registered) {
                  const stateText = yield* readLegacyText(statePath);
                  let state: LibraryState | undefined;
                  let stateVersion: number | undefined;
                  if (stateText !== undefined) {
                    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
                      stateText,
                    ).pipe(
                      Effect.mapError(
                        (failure) =>
                          new InvalidLibraryState({
                            path: statePath,
                            reason: { _tag: "SchemaInvalid", failure },
                          }),
                      ),
                    );
                    const version = yield* readStateVersion(statePath, value);
                    stateVersion = version;
                    if (!isLegacyVersion(version))
                      return yield* new InvalidLibraryState({
                        path: statePath,
                        reason: {
                          _tag: "UnsupportedVersion",
                          version: Math.max(-Number.MAX_VALUE, Math.min(version, Number.MAX_VALUE)),
                          oldest: OLDEST_LIBRARY_STATE_VERSION,
                          current: NEWEST_LIBRARY_STATE_FILE_VERSION,
                        },
                      });
                    state = yield* decodeCurrentState(
                      statePath,
                      yield* Schema.decodeEffect(LegacyLibraryState)(value).pipe(
                        Effect.mapError(
                          (failure) =>
                            new InvalidLibraryState({
                              path: statePath,
                              reason: { _tag: "SchemaInvalid", failure },
                            }),
                        ),
                      ),
                    );
                  }

                  const hash =
                    stateText === undefined
                      ? null
                      : yield* sha256Hash(new TextEncoder().encode(stateText));
                  const backup =
                    stateText === undefined
                      ? null
                      : `${statePath}.v${stateVersion}.backup-database`;
                  if (backup !== null && stateText !== undefined) {
                    const saved = yield* readLegacyText(backup);
                    if (saved !== undefined && saved !== stateText)
                      return yield* new InvalidLibraryState({
                        path: backup,
                        reason: {
                          _tag: "ImportBackupChanged",
                          sourcePath: statePath,
                          backupPath: backup,
                          databasePath: path,
                        },
                      });
                    if (saved === undefined) yield* writeRawAtomic(backup, stateText, true);
                    yield* syncPaths([backup, root]);
                  }
                  if ((yield* readLegacyHash(statePath)) !== hash)
                    return yield* new InvalidLibraryState({
                      path: statePath,
                      reason: {
                        _tag: "LegacySourceChanged",
                        sourcePath: statePath,
                        backupPath: backup,
                        databasePath: path,
                      },
                    });
                  yield* sql.withTransaction(
                    Effect.gen(function* () {
                      if (state !== undefined)
                        yield* saveDatabaseState(path, state, null).pipe(
                          Effect.catchTag("LibraryChanged", () =>
                            Effect.fail(
                              new InvalidLibraryState({
                                path,
                                reason: {
                                  _tag: "ImportRecordMissing",
                                  sourcePath: statePath,
                                },
                              }),
                            ),
                          ),
                        );
                      yield* sql`INSERT INTO library_import (source,backup,hash,fenced) VALUES ('state.json',${backup},${hash},0)`;
                    }),
                  );
                }
              }),
            );
            if (needsState) yield* finishDatabaseImport(root);
          }),
        () =>
          Effect.gen(function* () {
            if (!locked) return;
            const pending = yield* withLibraryDatabase(
              path,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                return (
                  (yield* sql`SELECT source FROM library_import WHERE source='state.json' AND fenced=0`)
                    .length > 0
                );
              }),
              true,
            );
            if (pending) return;
            if ((yield* readLegacyText(lockPath)) === databaseImportOwner) {
              yield* fs.remove(lockPath);
              yield* syncPaths([root]);
            }
          }),
      );
    }),
  );
});

/** Read one database snapshot without importing or checking machine settings. */
export const inspectLocalLibraryState = Effect.fn("Library.inspectState")(function* (
  home: string,
): Effect.fn.Return<
  InspectedLibraryState,
  PlatformError | InvalidLibraryState | LibrarySqlError,
  FileSystem.FileSystem | Digest.Digest
> {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path))) return { present: false };
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const { state, revision } = yield* readDatabaseState(path);
      const inspected: InspectedLibraryState =
        state === undefined || revision === null
          ? { present: false }
          : { present: true, state, revision };
      return inspected;
    }),
    true,
  );
});

/** Import this owner's sources before its first transaction; nested saves join the existing one. */
export const withLibraryTransaction = <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const active = yield* currentLibraryTransaction(home);
    if (active?.mode !== "locked-write") {
      const initialized =
        (yield* prepareLibraryDatabase(home)) &&
        (yield* withLibraryDatabase(
          libraryDatabasePath(home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const imports = yield* sql<{
              source: string;
              fenced: number;
            }>`SELECT source,fenced FROM library_import WHERE source IN ('state.json','audit.jsonl')`;
            return (
              imports.some((row) => row.source === "state.json" && row.fenced === 1) &&
              imports.some((row) => row.source === "audit.jsonl")
            );
          }),
          true,
        ));
      if (!initialized) yield* migrateLocalLibraryState(home, true);
    }
    return yield* withDatabaseTransaction(home, program);
  });

/** Domain compare-and-replace never reads or rewrites operation programs. */
export const saveLibraryState = Effect.fn("Library.saveState")(function* (
  home: string,
  next: LibraryState,
  base: LibraryState,
  action: HistoryAction,
  revision?: number,
) {
  const path = libraryDatabasePath(home);
  yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      const saved = yield* saveDatabaseState(path, next, base, revision);
      yield* saveLibraryHistory(path, action, diffLibraryState(base, saved));
    }),
  );
});

export const libraryHistoryAction = Effect.fn("Library.historyAction")(function* (
  home: string,
  workflow: string,
  resume?: OperationId,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (resume !== undefined && (yield* fs.exists(path))) {
    const prior = yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        // Recovery must refuse an invalid domain document before any filesystem step acts.
        yield* readDatabaseState(path);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ document: string }>`SELECT document FROM library_audit_events
        WHERE EXISTS (SELECT 1 FROM json_each(operation_ids) WHERE value = ${resume}) LIMIT 1`;
        if (!rows[0]) return undefined;
        return yield* Schema.decodeEffect(Schema.fromJsonString(StoredAuditEvent))(
          rows[0].document,
        ).pipe(
          Effect.mapError(
            (failure) =>
              new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
          ),
        );
      }),
      true,
    );
    if (prior)
      return { eventId: prior.eventId, occurredAt: prior.occurredAt, workflow: prior.workflow };
  }
  return {
    eventId: makeOperationId(),
    occurredAt: DateTime.formatIso(yield* DateTime.now),
    workflow,
  };
});
