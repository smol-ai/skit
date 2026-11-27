import { Array as EffectArray, Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as History from "../history/history.js";
import * as Sync from "../sync/sync.js";
import {
  libraryDatabasePath,
  withDatabaseTransaction,
  withLibraryDatabase,
} from "../library/store/database.js";
import { AuthorHistoryInvalid } from "./history-failures.js";
import { AuthorSyncStateInvalid, WorkspaceId, type SyncKey } from "./workspace-contracts.js";
import { AuthorRemovalState } from "./inventory.js";
import { LibrarySqlError, InvalidLibraryState } from "../library/failures.js";

const invalid = (path: string, failure: Schema.SchemaError) =>
  new AuthorSyncStateInvalid({ path, reason: { _tag: "InvalidData", failure } });
const decodeState = (path: string, value: unknown) =>
  Schema.decodeUnknownEffect(Sync.SyncState, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((error) => invalid(path, error)),
  );
const failed = (path: string, cause: unknown) =>
  new AuthorHistoryInvalid({ path, reason: { _tag: "JournalFailure", cause } });

/** Translate the shared database's storage failures at Author's ownership boundary. */
const storage = <A, E, R>(
  home: string,
  effect: Effect.Effect<A, E | LibrarySqlError | InvalidLibraryState, R>,
) =>
  effect.pipe(
    Effect.catchIf(Schema.is(Schema.Union([LibrarySqlError, InvalidLibraryState])), (error) =>
      Effect.fail(failed(libraryDatabasePath(home), error)),
    ),
  );

/** Current mutations join one short shared transaction, including a Library transaction if held. */
export const withAuthorStateTransaction = <A, E, R>(
  home: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) => storage(home, withDatabaseTransaction(home, effect));

const read = <A, E, R>(
  home: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  absent: A,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(libraryDatabasePath(home)))) return absent;
    return yield* storage(
      home,
      withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          return yield* (yield* SqlClient.SqlClient).withTransaction(effect);
        }),
        true,
      ),
    );
  });

export const readAuthorWorkspaces = (home: string) =>
  read(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ workspace_id: WorkspaceId, root: Schema.String })),
      )(
        yield* sql`SELECT workspace_id, root FROM author_history_workspaces
                   WHERE workspace_id IS NOT NULL ORDER BY root`,
      ).pipe(Effect.mapError((error) => failed(libraryDatabasePath(home), error)));
    }),
    [],
  );

export const readAuthorSyncLocators = (home: string) =>
  read(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ locator: Schema.String })),
      )(yield* sql`SELECT DISTINCT locator FROM author_sync_checkpoints`).pipe(
        Effect.mapError((error) => failed(libraryDatabasePath(home), error)),
      );
      return rows.map((row) => row.locator);
    }),
    [],
  );

/** Device-local workspace observations which have synced this Registry Draft. */
export const readDraftWorkspaceRows = (home: string) =>
  read(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ locator: string; workspaceId: string; path: string }>`
      SELECT c.locator, w.workspace_id AS workspaceId, w.root AS path
      FROM author_history_workspaces w JOIN author_sync_checkpoints c USING (workspace_id)`;
    }),
    [],
  );

/** One workspace/locator checkpoint, never the other workspaces' documents. */
export const readAuthorSyncState = (home: string, key: SyncKey) =>
  read(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            status: Schema.Literals(["Idle", "Sending", "Writing"]),
            base: Schema.NullOr(Schema.String),
            revision: Schema.NullOr(Schema.String),
            from_tree: Schema.NullOr(Schema.String),
            to_tree: Schema.NullOr(Schema.String),
            merged: Schema.NullOr(Schema.Literals([0, 1])),
            next_status: Schema.NullOr(Schema.Literals(["Idle", "Sending"])),
            next_base: Schema.NullOr(Schema.String),
            next_revision: Schema.NullOr(Schema.String),
          }),
        ),
      )(
        yield* sql`SELECT * FROM author_sync_checkpoints WHERE workspace_id=${key.workspaceId} AND locator=${key.locator}`,
      ).pipe(Effect.mapError((error) => invalid(libraryDatabasePath(home), error)));
      const row = rows[0];
      if (!row) return Sync.Idle.make({ base: null });
      return yield* decodeState(libraryDatabasePath(home), {
        _tag: row.status,
        base: row.base,
        ...(row.status === "Sending" ? { revision: row.revision } : {}),
        ...(row.status === "Writing"
          ? {
              from: row.from_tree,
              to: row.to_tree,
              merged:
                (yield* Schema.decodeUnknownEffect(Schema.Literals([0, 1]))(row.merged).pipe(
                  Effect.mapError((error) => invalid(libraryDatabasePath(home), error)),
                )) === 1,
              next: {
                _tag: row.next_status,
                base: row.next_base,
                ...(row.next_status === "Sending" ? { revision: row.next_revision } : {}),
              },
            }
          : {}),
      });
    }),
    Sync.Idle.make({ base: null }),
  );

/** The caller has compared its checkpoint inside this transaction before reaching this write. */
export const saveAuthorSyncState = Effect.fn("AuthorState.saveSync")(function* (
  home: string,
  key: SyncKey,
  state: Sync.SyncState,
  resetBackup = false,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* decodeState(libraryDatabasePath(home), state);
  yield* sql`INSERT INTO author_workspace_state (workspace_id,sync_present,backup_present) VALUES (${key.workspaceId},1,0) ON CONFLICT(workspace_id) DO UPDATE SET sync_present=1`;
  yield* sql`DELETE FROM author_sync_checkpoints WHERE workspace_id=${key.workspaceId} AND locator=${key.locator}`;
  yield* sql`INSERT INTO author_sync_checkpoints ${sql.insert({
    workspace_id: key.workspaceId,
    locator: key.locator,
    status: state._tag,
    base: state.base,
    revision: state._tag === "Sending" ? state.revision : null,
    from_tree: state._tag === "Writing" ? state.from : null,
    to_tree: state._tag === "Writing" ? state.to : null,
    merged: state._tag === "Writing" ? Number(state.merged) : null,
    next_status: state._tag === "Writing" ? state.next._tag : null,
    next_base: state._tag === "Writing" ? state.next.base : null,
    next_revision:
      state._tag === "Writing" && state.next._tag === "Sending" ? state.next.revision : null,
  })}`;
  if (resetBackup)
    yield* sql`DELETE FROM author_backup_checkpoints WHERE workspace_id=${key.workspaceId} AND locator=${key.locator}`;
});

export const readAuthorBackup = (home: string, key: SyncKey) =>
  read(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ revision: Schema.String })),
      )(
        yield* sql`SELECT revision FROM author_backup_checkpoints WHERE workspace_id=${key.workspaceId} AND locator=${key.locator}`,
      ).pipe(Effect.mapError((error) => invalid(libraryDatabasePath(home), error))))[0];
      return row
        ? yield* Schema.decodeUnknownEffect(History.RevisionId)(row.revision).pipe(
            Effect.mapError((error) => invalid(libraryDatabasePath(home), error)),
          )
        : null;
    }),
    null,
  );

export const saveAuthorBackup = Effect.fn("AuthorState.saveBackup")(function* (
  key: SyncKey,
  revision: History.RevisionId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE author_state_fields SET backups_present=1 WHERE id=1`;
  yield* sql`INSERT INTO author_workspace_state (workspace_id,sync_present,backup_present) VALUES (${key.workspaceId},0,1) ON CONFLICT(workspace_id) DO UPDATE SET backup_present=1`;
  yield* sql`INSERT INTO author_backup_checkpoints (workspace_id,locator,revision) VALUES (${key.workspaceId},${key.locator},${revision}) ON CONFLICT(workspace_id,locator) DO UPDATE SET revision=excluded.revision`;
});

export const readAuthorInventory = (home: string, workspace: WorkspaceId) =>
  read(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ workspace_id: Schema.String })),
      )(
        yield* sql`SELECT workspace_id FROM author_inventories WHERE workspace_id=${workspace}`,
      ).pipe(Effect.mapError((error) => invalid(libraryDatabasePath(home), error))))[0];
      if (!row) return undefined;
      const paths = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            category: Schema.Literals(["files", "members", "removedFiles", "removedMembers"]),
            path: Schema.String,
          }),
        ),
      )(
        yield* sql`SELECT category,path FROM author_inventory_paths WHERE workspace_id=${workspace} ORDER BY position`,
      ).pipe(Effect.mapError((error) => invalid(libraryDatabasePath(home), error)));
      const items = (category: string) =>
        paths.filter((item) => item.category === category).map((item) => item.path);
      return yield* Schema.decodeUnknownEffect(AuthorRemovalState, { onExcessProperty: "error" })({
        inventory: {
          files: items("files"),
          members: items("members"),
        },
        removedFiles: items("removedFiles"),
        removedMembers: items("removedMembers"),
      }).pipe(Effect.mapError((error) => invalid(libraryDatabasePath(home), error)));
    }),
    undefined,
  );

export const saveAuthorInventory = Effect.fn("AuthorState.saveInventory")(function* (
  home: string,
  workspace: WorkspaceId,
  state: AuthorRemovalState,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Schema.decodeUnknownEffect(AuthorRemovalState, { onExcessProperty: "error" })(state).pipe(
    Effect.mapError((error) => invalid(libraryDatabasePath(home), error)),
  );
  yield* sql`UPDATE author_state_fields SET inventories_present=1 WHERE id=1`;
  yield* sql`INSERT INTO author_workspace_state (workspace_id,sync_present,backup_present) VALUES (${workspace},0,0) ON CONFLICT(workspace_id) DO NOTHING`;
  yield* sql`INSERT INTO author_inventories (workspace_id) VALUES (${workspace}) ON CONFLICT(workspace_id) DO NOTHING`;
  yield* sql`DELETE FROM author_inventory_paths WHERE workspace_id=${workspace}`;
  const rows = ["files", "members", "removedFiles", "removedMembers"].flatMap((category) => {
    const paths =
      category === "files"
        ? state.inventory.files
        : category === "members"
          ? state.inventory.members
          : category === "removedFiles"
            ? state.removedFiles
            : state.removedMembers;
    return paths.map((path, position) => ({ workspace_id: workspace, category, position, path }));
  });
  for (const batch of EffectArray.chunksOf(rows, 500))
    yield* sql`INSERT INTO author_inventory_paths ${sql.insert(batch)}`;
});
