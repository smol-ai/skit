import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { join, resolve } from "node:path";
import { sha256Hash } from "../../shared/hash.js";
import { syncPaths, writeRawAtomic } from "../../platform/atomic-write.js";
import { HomeBusy } from "../../platform/lock-failures.js";
import { InvalidLibraryState } from "../failures.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withDatabaseTransaction,
  withLibraryDatabase,
} from "./database.js";
import { loadMachineRows, saveMachineRows } from "./machine-rows.js";
import { LegacyMachineId, MachineId, migratedMachineId } from "../entity-ids.js";
import { Unusable } from "../machine-settings-failures.js";
import { CurrentMachineDocument, MachineRepositoryDecision } from "../machine-document.js";

const MachineDocumentV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repositoryRoots: Schema.Array(Schema.String),
});

const MachineDocumentV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  machineId: LegacyMachineId,
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  repositoryRoots: Schema.optionalKey(Schema.Array(Schema.String)),
});

const MachineDocumentV3 = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  machineId: MachineId,
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  repositoryRoots: Schema.optionalKey(Schema.Array(Schema.String)),
});

const MachineDocumentV4 = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  machineId: MachineId,
  displayName: Schema.NonEmptyString,
  discoveryRoots: Schema.Array(Schema.String),
  repositories: Schema.Array(MachineRepositoryDecision),
});

/** V5 preserves discovery initialization independently of creating a machine identity. */
const MachineDocumentV5 = Schema.Struct({
  ...MachineDocumentV4.fields,
  schemaVersion: Schema.Literal(5),
  repositoryDecisionsInitialized: Schema.Boolean,
});

/** Released machine.json formats are recognized only while the store imports them. */
export const loadMachineFile = Effect.fn("Library.loadMachineFile")(function* (
  path: string,
  savedText?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text =
    savedText ??
    (yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchTag("PlatformError", (failure) =>
          failure.reason._tag === "NotFound"
            ? Effect.undefined
            : Effect.fail(new Unusable({ path, reason: { _tag: "ReadFailed", failure } })),
        ),
      ));
  if (text === undefined) return undefined;
  const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(text).pipe(
    Effect.mapError((failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } })),
  );
  const supported = [1, 2, 3, 4, 5];
  if (Schema.is(Schema.Int)(value.schemaVersion) && !supported.includes(value.schemaVersion))
    return yield* new Unusable({
      path,
      reason: { _tag: "UnsupportedVersion", version: value.schemaVersion, supported },
    });
  return yield* Effect.gen(function* () {
    const document = yield* Schema.decodeUnknownEffect(
      Schema.Union([
        MachineDocumentV5,
        MachineDocumentV4,
        MachineDocumentV3,
        MachineDocumentV2,
        MachineDocumentV1,
      ]),
    )(value);
    if (document.schemaVersion === 5)
      return yield* Schema.decodeUnknownEffect(CurrentMachineDocument)(value);
    if (document.schemaVersion === 4)
      return yield* Schema.decodeUnknownEffect(CurrentMachineDocument)({
        ...value,
        schemaVersion: 5,
        repositoryDecisionsInitialized: true,
      });
    const identity =
      document.schemaVersion === 2
        ? {
            machineId: migratedMachineId(document.machineId, document.machineId),
            legacyMachineId: document.machineId,
          }
        : document.schemaVersion === 3
          ? { machineId: document.machineId }
          : {};
    const { repositoryRoots: _roots, ...kept } = value;
    return yield* Schema.decodeUnknownEffect(CurrentMachineDocument)({
      ...kept,
      schemaVersion: 5,
      ...identity,
      discoveryRoots: document.repositoryRoots ?? [],
      repositories: [],
      repositoryDecisionsInitialized: false,
    });
  }).pipe(
    Effect.mapError((failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } })),
  );
});

const machineStub = '{"schemaVersion":6}\n';
const machineImportOwner = "skit-machine-database-import\n";

const readMachineText = Effect.fn("MachineSettings.readSource")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (failure) =>
        failure.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.fail(new Unusable({ path, reason: { _tag: "ReadFailed", failure } })),
      ),
    );
});

const loadMachineImport = Effect.fn("MachineSettings.loadImport")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    hash: string | null;
    backup: string | null;
  }>`SELECT hash,backup FROM library_import WHERE source='machine.json'`)[0];
});

/** Import and read only machine settings; neither Library values nor its source file are checked. */
export const loadMachineSettings = Effect.fn("MachineSettings.load")(function* (
  home: string,
  create = false,
) {
  const root = resolve(home);
  const path = libraryDatabasePath(root);
  const source = join(root, "machine.json");
  const backup = `${source}.backup-database`;
  const lock = join(root, ".lock");
  const fs = yield* FileSystem.FileSystem;
  const text = yield* readMachineText(source);
  if (!(yield* prepareLibraryDatabase(root, create || text !== undefined))) return undefined;
  const stored = yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const record = yield* loadMachineImport();
          return record ? { record, value: yield* loadMachineRows(path) } : undefined;
        }),
      );
    }),
    true,
  );
  if (stored && text === machineStub && (yield* readMachineText(lock)) !== machineImportOwner)
    return stored.value;
  if (!stored && text === undefined && !create) return undefined;

  return yield* withDatabaseTransaction(
    root,
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        yield* writeRawAtomic(lock, machineImportOwner, true).pipe(
          Effect.catchReason("PlatformError", "AlreadyExists", () =>
            Effect.gen(function* () {
              const owner = yield* readMachineText(lock);
              if (owner !== machineImportOwner)
                return yield* new HomeBusy({ path: lock, owner: owner ?? "unknown" });
            }),
          ),
        );
      }),
      () =>
        Effect.gen(function* () {
          const record = yield* loadMachineImport();
          const live = yield* readMachineText(source);
          const original = live === machineStub ? yield* readMachineText(backup) : live;
          const hash =
            original === undefined ? null : yield* sha256Hash(new TextEncoder().encode(original));

          if (record && live !== undefined && live !== machineStub && hash !== record.hash)
            return yield* new InvalidLibraryState({
              path: source,
              reason: {
                _tag: "LegacySourceChanged",
                sourcePath: source,
                backupPath: record.backup,
                databasePath: path,
              },
            });

          const document =
            !record && original !== undefined
              ? yield* loadMachineFile(source, original)
              : undefined;
          if (live !== machineStub && original !== undefined) {
            const existing = yield* readMachineText(backup);
            if (existing !== undefined && existing !== original)
              return yield* new InvalidLibraryState({
                path: backup,
                reason: {
                  _tag: "ImportBackupChanged",
                  sourcePath: source,
                  backupPath: backup,
                  databasePath: path,
                },
              });
            if (existing === undefined) yield* writeRawAtomic(backup, original, true);
            yield* syncPaths([backup, root]);
          }

          // The old CLI now refuses this file. Until the rows commit, the backup is authoritative.
          if (live !== machineStub) yield* writeRawAtomic(source, machineStub);
          yield* syncPaths([source, root]);
          const sql = yield* SqlClient.SqlClient;
          if (document !== undefined) yield* saveMachineRows(path, document);
          if (record === undefined)
            yield* sql`INSERT INTO library_import (source,backup,hash,fenced) VALUES ('machine.json',${original === undefined ? null : backup},${hash},1)`;
          else if (record.backup === null && original !== undefined)
            yield* sql`UPDATE library_import SET backup=${backup} WHERE source='machine.json'`;
          return yield* loadMachineRows(path);
        }),
      () =>
        Effect.gen(function* () {
          if ((yield* readMachineText(lock)) === machineImportOwner) {
            yield* fs.remove(lock);
            yield* syncPaths([root]);
          }
        }).pipe(Effect.orDie),
    ),
  );
});
