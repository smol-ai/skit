import { saveCollectionRemoval, type CollectionRemoval } from "./remove.js";
import { loadLegacyHistory } from "./legacy-history.js";
import { saveInstalledSkills, type InstalledSkillsChange } from "./installed.js";
import { Effect, FileSystem, Option, Schema } from "effect";
import { hashParts } from "../../artifact/descriptor.js";
import { loadMachineRows, saveMachineRows } from "./machine-rows.js";
import { CurrentSetupOperation, prepareSetupChanges } from "./setup-intent.js";
import { setupIntent } from "./intent.js";
import * as MachineSettings from "../machine-settings.js";
import { SqlClient } from "effect/sql";
import { canonicalJson } from "../../shared/json.js";
import { StalePlan } from "../plan-failures.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { emptyLibraryState, type LibraryState } from "../library-state.js";
import { recordedLibrary } from "./intent.js";
import { snapshotOf, snapshotDatabaseRevision, type Snapshot } from "../snapshot.js";
import {
  OperationStatus,
  RecordedSetupStep,
  OperationKind,
  type OperationSummary,
  type OperationStepSummary,
  type SetupStopReason,
} from "./state-schema.js";
import type { LibraryAuditChange } from "../audit/contracts.js";
import type { HistoryAction } from "./history-action.js";
import { libraryDatabasePath, withLibraryDatabase } from "./database.js";
import {
  readDatabaseStateRevision,
  saveDatabaseState,
  saveLibraryHistory,
  withLibraryTransaction,
} from "./state-file.js";
import { diffLibraryState } from "../audit/state-diff.js";
import { prepareLibrarySide } from "./difference.js";
import { saveSetupUndoState } from "./undo.js";
import { decodeCatalogue } from "./catalogue.js";
import { EnabledState } from "./enabled.js";
import { loadCatalogueRows, loadEnabledRows, loadInstalledSkillRows } from "./rows.js";

export type OperationPublication =
  | { readonly next: LibraryState; readonly base: LibraryState }
  | InstalledSkillsChange
  | CollectionRemoval;

export type PendingOperation = Extract<OperationStatus, { readonly _tag: "Pending" }>;

/** Unknown-kind terminal rows must validate as full programs, never fall back to a summary. */
const decodeOperation = (path: string, document: string, kind?: string | null) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(document);
    const legacyBefore =
      typeof value.before === "object" &&
      value.before !== null &&
      Object.hasOwn(value.before, "intent");
    const afterIntent =
      typeof value.after === "object" &&
      value.after !== null &&
      Object.hasOwn(value.after, "intent");
    if (
      (kind === "setup" || value.kind === "setup" || (kind === null && legacyBefore)) &&
      (value.setup === undefined || legacyBefore || afterIntent)
    )
      return yield* new InvalidLibraryState({
        path,
        reason: { _tag: "InvalidData", issue: "Unsupported unreleased setup record" },
      });
    if (value._tag !== "Pending" && value.kind === undefined)
      yield* Schema.decodeUnknownEffect(Schema.Struct({ steps: Schema.Array(RecordedSetupStep) }))(
        value,
      );
    return yield* Schema.decodeUnknownEffect(OperationStatus)(value);
  }).pipe(
    Effect.catchTag("SchemaError", (failure) =>
      Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
    ),
  );

/** Decode one complete row on the caller's transaction/connection. */
const readOperation = Effect.fn("Library.readOperation")(function* (
  path: string,
  operationId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    document: string;
    kind: string | null;
  }>`SELECT document,kind FROM library_operations WHERE operation_id = ${operationId}`;
  if (!rows[0]) return undefined;
  return yield* decodeOperation(path, rows[0].document, rows[0].kind);
});

/** One compact shape for history, startup diagnostics and settled known-kind records. */
export function operationSummary(
  operation: Extract<OperationStatus, { readonly _tag: "Stopped" }>,
): Extract<OperationSummary, { readonly _tag: "Stopped" }>;
export function operationSummary(
  operation: Exclude<OperationStatus, { readonly _tag: "Pending" }>,
): Exclude<OperationSummary, { readonly _tag: "Pending" }>;
export function operationSummary(operation: OperationStatus): OperationSummary;
export function operationSummary(operation: OperationStatus): OperationSummary {
  const fields = {
    operationId: operation.operationId,
    before: operation.before,
    ...(operation.setup === undefined ? {} : { setup: operation.setup }),
    steps: operation.steps.map(({ step, before, after, status }): OperationStepSummary => ({
      step:
        step._tag === "Undo"
          ? {
              _tag: step._tag,
              program: { operationId: step.program.operationId, backupId: step.program.backupId },
            }
          : { _tag: step._tag },
      before: before.flatMap((item) => (item._tag === "Retained" ? [] : [item])),
      after: after.flatMap((item) => (item._tag === "Retained" ? [] : [item])),
      status,
    })),
  };
  if (operation._tag === "Pending") return { _tag: "Pending", ...fields };
  const terminal = {
    ...fields,
    after: operation.after,
    ...(operation.kind === undefined ? {} : { kind: operation.kind }),
  };
  if (operation._tag === "Undone")
    return {
      _tag: "Undone",
      ...terminal,
      ...(operation.reason === undefined ? {} : { reason: operation.reason }),
    };
  return operation._tag === "Done"
    ? { _tag: "Done", ...terminal }
    : { _tag: "Stopped", ...terminal, reason: operation.reason };
}

/** Encode the validated executable or compact terminal record. */
const encodeOperation = (path: string, operation: OperationStatus) =>
  Schema.encodeEffect(Schema.fromJsonString(OperationStatus))(operation).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );

/** Decode durable rows once; executable data never crosses the public history boundary. */
const loadOperationRows = Effect.fn("Library.loadOperationRows")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path))) return [];
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        document: string;
        kind: string | null;
      }>`SELECT document, kind FROM library_operations ORDER BY position`;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const kind = yield* Schema.decodeUnknownEffect(Schema.NullOr(OperationKind))(
            row.kind,
          ).pipe(
            Effect.mapError(
              (failure) =>
                new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
            ),
          );
          return { operation: yield* decodeOperation(path, row.document, kind), kind };
        }),
      );
    }),
    true,
  );
});

/** Recovery and Undo alone load complete Pending programs or retained terminal evidence. */
export const loadOperations = (home: string) =>
  Effect.map(loadOperationRows(home), (rows) => rows.map((row) => row.operation));

/** Public history exposes the explicit entry kind and compact Pending/settled evidence only. */
export const loadOperationHistory = Effect.fn("Library.loadOperationHistory")(function* (
  home: string,
) {
  const rows = yield* loadOperationRows(home);
  const current = rows.map(({ operation, kind }) => ({
    ...operationSummary(operation),
    ...(kind === null ? {} : { kind }),
  }));
  const byId = new Map(current.map((row) => [row.operationId, row]));
  const history: OperationSummary[] = [];
  for (const legacy of yield* loadLegacyHistory(home)) {
    const active = byId.get(legacy.id);
    if (active) {
      history.push(active);
      byId.delete(legacy.id);
    } else if (legacy.summary) history.push(legacy.summary);
  }
  return [...history, ...byId.values()];
});

/** Retained stopped/legacy records need intent and Installed Skills, never caches or Sync bases. */
const loadRecordedLibrary = Effect.fn("Library.loadRecordedLibrary")(
  function* (path: string) {
    const catalogue = yield* decodeCatalogue(path, yield* loadCatalogueRows());
    const enabled = yield* Schema.decodeUnknownEffect(EnabledState)(yield* loadEnabledRows());
    return {
      intent: setupIntent({ ...catalogue, ...enabled }),
      installedSkills: yield* loadInstalledSkillRows(path),
    };
  },
  (effect, path) =>
    effect.pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
);

/** Accept the program, initial Sync rows and action linkage together before filesystem effects. */
export const recordOperation = Effect.fn("Library.recordOperation")(function* (
  home: string,
  operation: PendingOperation,
  base: Snapshot,
  kind: OperationKind,
  action: HistoryAction,
  replaceDone = false,
) {
  const path = libraryDatabasePath(home);
  yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stored = yield* readDatabaseStateRevision(path);
      // Presence is part of acceptance, including the first empty Library document.
      const revision = snapshotDatabaseRevision(base.revision);
      let state: LibraryState;
      if (base._tag === "Present") {
        if (
          revision === undefined ||
          stored.revision !== revision ||
          snapshotOf({ present: true, state: base.state, revision }).revision !== base.revision
        )
          return yield* new LibraryChanged({ path });
        state = base.state;
      } else {
        if (stored.revision !== null || base.revision !== snapshotOf({ present: false }).revision)
          return yield* new LibraryChanged({ path });
        state = emptyLibraryState();
      }
      const existing =
        yield* sql`SELECT operation_id FROM library_operations WHERE operation_id = ${operation.operationId}`;
      if (existing.length)
        return yield* new StalePlan({ reason: { _tag: "OperationAlreadyRecorded" } });
      const pending = OperationStatus.cases.Pending.make({
        ...operation,
        before:
          kind === "setup"
            ? { installedSkills: structuredClone(state.installed_skills) }
            : recordedLibrary(state),
        ...(kind === "setup"
          ? {
              setup: {
                ...operation.setup,
                changes: yield* prepareSetupChanges(setupIntent(state), setupIntent(state), path),
              },
            }
          : {}),
      });
      const document = yield* encodeOperation(path, pending);
      const removed =
        replaceDone && kind === "setup"
          ? yield* sql<{
              operation_id: string;
            }>`SELECT operation_id FROM library_operations WHERE kind = 'setup' AND (json_extract(document, '$._tag') = 'Done' OR (json_extract(document, '$._tag') = 'Undone' AND json_type(document, '$.reason') IS NULL))`
          : [];
      if (replaceDone && kind === "setup")
        yield* sql`DELETE FROM library_operations WHERE kind = 'setup' AND (json_extract(document, '$._tag') = 'Done' OR (json_extract(document, '$._tag') = 'Undone' AND json_type(document, '$.reason') IS NULL))`;
      const positions = yield* sql<{
        next: number;
      }>`SELECT COALESCE(MAX(position) + 1, 0) AS next FROM library_operations`;
      if (stored.revision === null) yield* saveDatabaseState(path, state, null);
      yield* sql`INSERT INTO library_operations (position, operation_id, kind, document) VALUES (${positions[0]!.next}, ${pending.operationId}, ${kind}, ${document})`;
      const changes: LibraryAuditChange[] = removed.map((item) => ({
        entity: "library",
        id: item.operation_id,
        action: "operation-replaced",
      }));
      changes.push({ entity: "library", id: pending.operationId, action: "operation-Pending" });
      const first = pending.steps[0]?.step;
      if (
        kind === "sync" &&
        first?._tag === "Sync" &&
        first.phase === "retire" &&
        first.program.save === "before"
      ) {
        const next = yield* prepareLibrarySide(first.program.difference, state, "after", path);
        const revision = (yield* readDatabaseStateRevision(path)).revision;
        if (revision === null) return yield* new LibraryChanged({ path });
        const saved = yield* saveDatabaseState(path, next, state, revision);
        changes.push(...diffLibraryState(state, saved));
      }
      yield* saveLibraryHistory(path, action, changes, [pending.operationId]);
    }),
  );
});

/** Compare the complete base program before changing either progress or domain state. */
export const saveOperation = Effect.fn("Library.saveOperation")(function* (
  home: string,
  next: PendingOperation,
  base: PendingOperation,
  action: HistoryAction,
  publication?: OperationPublication,
) {
  const path = libraryDatabasePath(home);
  yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* readDatabaseStateRevision(path);
      const current = yield* readOperation(path, base.operationId);
      if (
        current?._tag !== "Pending" ||
        canonicalJson(current) !== canonicalJson(base) ||
        next.operationId !== base.operationId ||
        canonicalJson(next.before) !== canonicalJson(base.before) ||
        canonicalJson(next.setup ?? null) !== canonicalJson(base.setup ?? null)
      )
        return yield* new LibraryChanged({ path });
      let changes: ReturnType<typeof diffLibraryState> = [];
      if (publication && "removeCollection" in publication)
        yield* saveCollectionRemoval(home, publication, action);
      else if (publication && "installedSkills" in publication)
        yield* saveInstalledSkills(home, publication, action);
      else if (publication) {
        const saved = yield* saveDatabaseState(path, publication.next, publication.base);
        changes = diffLibraryState(publication.base, saved);
      }
      // The publication can advance setup Undo progress in this same transaction. Carry that
      // owner-written progress forward; callers may update step evidence, not setup intent.
      const active = yield* CurrentSetupOperation;
      const updated = active === base.operationId ? yield* readOperation(path, active) : undefined;
      const document = yield* encodeOperation(
        path,
        updated?.setup ? { ...next, setup: updated.setup } : next,
      );
      yield* sql`UPDATE library_operations SET document = ${document} WHERE operation_id = ${base.operationId}`;
      yield* saveLibraryHistory(path, action, changes, [base.operationId]);
    }),
  );
});

/** Settlement never inserts a missing row or overwrites a row already settled. */
export const settleOperation = Effect.fn("Library.settleOperation")(function* (
  home: string,
  base: PendingOperation,
  action: HistoryAction,
  reason?: SetupStopReason,
) {
  const path = libraryDatabasePath(home);
  yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* readDatabaseStateRevision(path);
      const current = yield* readOperation(path, base.operationId);
      if (current?._tag !== "Pending" || canonicalJson(current) !== canonicalJson(base))
        return yield* new LibraryChanged({ path });
      const kinds = yield* sql<{
        kind: string | null;
      }>`SELECT kind FROM library_operations WHERE operation_id = ${base.operationId}`;
      const kind = yield* Schema.decodeUnknownEffect(Schema.NullOr(OperationKind))(
        kinds[0]?.kind ?? null,
      ).pipe(
        Effect.mapError(
          (failure) =>
            new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
        ),
      );
      if (reason === undefined && (kind === "apply" || kind === "sync" || kind === "undo")) {
        yield* saveLibraryHistory(
          path,
          action,
          [{ entity: "library", id: base.operationId, action: "operation-Done" }],
          [base.operationId],
        );
        yield* sql`DELETE FROM library_operations WHERE operation_id = ${base.operationId}`;
        return;
      }
      let setup = current.setup;
      if (reason === undefined && kind === "setup" && setup?.machineChoices) {
        const before = yield* MachineSettings.read(home);
        const after = yield* MachineSettings.updateDiscovery(home, setup.machineChoices);
        setup = {
          ...setup,
          discovery: {
            before: {
              discoveryRoots: [...before.discoveryRoots],
              ...(before.machineId === undefined ? {} : { machineId: before.machineId }),
            },
            expectedAfter: {
              discoveryRoots: [...after.discoveryRoots],
              ...(after.machineId === undefined ? {} : { machineId: after.machineId }),
            },
          },
        };
      }
      const fields = {
        ...(setup === undefined
          ? {}
          : {
              setup: {
                changes: setup.changes,
                ...(setup.discovery === undefined ? {} : { discovery: setup.discovery }),
              },
            }),
        ...(kind === null ? {} : { kind }),
        operationId: current.operationId,
        steps: current.steps,
        before: current.before,
        after:
          kind === "setup"
            ? {
                installedSkills: yield* loadInstalledSkillRows(path),
              }
            : yield* loadRecordedLibrary(path),
      };
      const terminal =
        reason === undefined
          ? OperationStatus.cases.Done.make(fields)
          : OperationStatus.cases.Stopped.make({ ...fields, reason });
      yield* saveLibraryHistory(
        path,
        action,
        [{ entity: "library", id: base.operationId, action: `operation-${terminal._tag}` }],
        [base.operationId],
      );
      const document = yield* encodeOperation(
        path,
        kind === null ? terminal : operationSummary(terminal),
      );
      yield* sql`UPDATE library_operations SET document = ${document} WHERE operation_id = ${base.operationId}`;
    }),
  );
});

export const loadOperation = Effect.fn("Library.loadOperation")(function* (
  home: string,
  operationId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path))) return Option.none<OperationStatus>();
  return yield* withLibraryDatabase(
    path,
    readOperation(path, operationId).pipe(Effect.map(Option.fromUndefinedOr)),
    true,
  );
});

/** The inverse, discovery folders and target status become durable in one SQL transaction. */
export const saveSetupUndo = Effect.fn("Library.saveSetupUndo")(function* (
  home: string,
  program: import("./state-schema.js").UndoProgram,
  next: LibraryState,
  base: LibraryState,
  action: HistoryAction,
  revision: number,
) {
  const path = libraryDatabasePath(home);
  yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      const target = yield* readOperation(path, program.operationId);
      if (!target || !target.setup || target._tag === "Pending")
        return yield* new LibraryChanged({ path });
      if (target._tag === "Undone") return;
      if (program.discovery) {
        const current = yield* MachineSettings.read(home);
        const hash = hashParts([canonicalJson(current)]);
        if (hash !== program.discovery.beforeHash && hash !== program.discovery.afterHash)
          return yield* new LibraryChanged({ path });
        if (hash !== program.discovery.afterHash) {
          const document = yield* loadMachineRows(path);
          if (document === undefined) return yield* new LibraryChanged({ path });
          yield* saveMachineRows(path, {
            ...document,
            schemaVersion: 5,
            discoveryRoots: [...program.discovery.after.discoveryRoots],
          });
        }
      }
      yield* saveSetupUndoState(path, next, base, revision);
      const sql = yield* SqlClient.SqlClient;
      // Failed attempts keep backup pointers until the complete inverse has been saved.
      const attempts = yield* sql<{
        operation_id: string;
      }>`SELECT operation_id FROM library_operations WHERE kind='undo' AND json_extract(document,'$._tag')='Stopped' AND EXISTS (SELECT 1 FROM json_each(library_operations.document,'$.steps') AS step WHERE json_extract(step.value,'$.step._tag')='Undo' AND json_extract(step.value,'$.step.program.operationId')=${program.operationId})`;
      for (const attempt of attempts)
        yield* sql`DELETE FROM library_operations WHERE operation_id=${attempt.operation_id}`;
      const { _tag: _status, ...fields } = target;
      const document = yield* encodeOperation(path, OperationStatus.cases.Undone.make(fields));
      yield* sql`UPDATE library_operations SET document=${document} WHERE operation_id=${program.operationId}`;
      yield* saveLibraryHistory(
        path,
        action,
        [
          ...diffLibraryState(base, next),
          ...attempts.map(
            (attempt) =>
              ({
                entity: "library",
                id: attempt.operation_id,
                action: "operation-replaced",
              }) satisfies LibraryAuditChange,
          ),
          { entity: "library", id: program.operationId, action: "operation-Undone" },
        ],
        [target.operationId],
      );
    }),
  );
});
