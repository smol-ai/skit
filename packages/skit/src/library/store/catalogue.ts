import type { ImportId } from "../entity-ids.js";
import { Effect, FileSystem, Schema, Struct } from "effect";
import { SqlClient } from "effect/sql";
import {
  LibraryManifest,
  CURRENT_PORTABLE_LIBRARY_SCHEMA,
  librarySnapshotDigests,
  enabledSkillIds,
} from "../library-contracts.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { normalizeCatalogue } from "../manifest.js";
import { emptyLibraryState } from "../library-state.js";
import { LibraryStateFields } from "./state-fields.js";
import { canonicalJson, JsonObject, arrayAt, isJsonObject, stringAt } from "../../shared/json.js";
import { libraryDatabasePath, withLibraryDatabase } from "./database.js";
import { loadCatalogueRows, saveCatalogueRows, loadEnabledRows } from "./rows.js";
import { EnabledState } from "./enabled.js";
import { saveCatalogueBase } from "./catalogue-base.js";
import { diffCatalogue, diffEnabled } from "../audit/state-diff.js";
import { setupIntent } from "./intent.js";
import {
  advanceLibraryRevision,
  readDatabaseStateRevision,
  saveDatabaseState,
  saveLibraryHistory,
  saveSetupIntentProgress,
  withLibraryTransaction,
} from "./state-file.js";
import type { HistoryAction } from "./history-action.js";

const fields = ["collections", "skills", "collection_versions", "imports"] as const;
const CatalogueFields = Schema.Struct(Struct.pick(LibraryStateFields, fields));
export type Catalogue = typeof CatalogueFields.Type;
const Catalogue = CatalogueFields;

/** Validate the catalogue's own relationships without constructing device or operation state. */
export const decodeCatalogue = Effect.fn("Library.decodeCatalogue")(
  function* (path: string, input: unknown) {
    const document = yield* Schema.decodeUnknownEffect(JsonObject)(input);
    const catalogue = yield* Schema.decodeUnknownEffect(Catalogue, { onExcessProperty: "error" })(
      Struct.pick(document, fields),
    );
    yield* Schema.decodeUnknownEffect(LibraryManifest)({
      schema: CURRENT_PORTABLE_LIBRARY_SCHEMA,
      ...Struct.pick(catalogue, fields),
      enabled: [],
      snapshot_digests: librarySnapshotDigests(catalogue),
    });
    return normalizeCatalogue(catalogue);
  },
  (effect, path) =>
    effect.pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
);

/** One read transaction supplies catalogue facts and their native freshness token. */
export const readCatalogue = Effect.fn("Library.readCatalogue")(function* (home: string) {
  const path = libraryDatabasePath(home);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path)))
    return { value: Struct.pick(emptyLibraryState(), fields), revision: null };
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const { revision } = yield* readDatabaseStateRevision(path);
          const value = yield* decodeCatalogue(path, yield* loadCatalogueRows());
          if (revision === null && fields.some((field) => value[field].length))
            return yield* new InvalidLibraryState({
              path,
              reason: { _tag: "ContentMissing", entry: "library_device" },
            });
          return { value, revision };
        }),
      );
    }),
    true,
  ).pipe(
    Effect.catchTag("SchemaError", (failure) =>
      Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
    ),
  );
});

/** An import adds immutable facts; it cannot rewrite or discard an earlier import or file tree. */
export const checkCatalogueChange = Effect.fn("Library.checkCatalogueChange")(function* (
  path: string,
  next: JsonObject,
  base: JsonObject,
) {
  for (const entity of [
    { field: "collections", id: "collection_id", immutable: false },
    { field: "skills", id: "skill_id", immutable: false },
    { field: "collection_versions", id: "collection_version_id", immutable: true },
    { field: "imports", id: "import_id", immutable: true },
  ]) {
    const desired = new Map(
      arrayAt(next, entity.field)
        .filter(isJsonObject)
        .map((row) => [stringAt(row, entity.id), row]),
    );
    for (const row of arrayAt(base, entity.field).filter(isJsonObject)) {
      const after = desired.get(stringAt(row, entity.id));
      if (!after || (entity.immutable && canonicalJson(after) !== canonicalJson(row)))
        return yield* new InvalidLibraryState({
          path,
          reason: {
            _tag: "CatalogueRowChanged",
            field: entity.field,
            id: stringAt(row, entity.id),
          },
        });
      if (entity.field === "skills") {
        const versions = new Map(
          arrayAt(after, "versions")
            .filter(isJsonObject)
            .map((item) => [stringAt(item, "skill_version_id"), item]),
        );
        for (const version of arrayAt(row, "versions").filter(isJsonObject))
          if (
            canonicalJson(versions.get(stringAt(version, "skill_version_id"))) !==
            canonicalJson(version)
          )
            return yield* new InvalidLibraryState({
              path,
              reason: {
                _tag: "CatalogueRowChanged",
                field: "skill_versions",
                id: stringAt(version, "skill_version_id"),
              },
            });
      }
    }
  }
});

/** Select this import in the same transaction that makes its retained content available. */
const selectDraftImport = Effect.fn("Library.selectDraftImport")(function* (
  path: string,
  catalogue: Catalogue,
  id: ImportId,
) {
  const source = catalogue.imports.find((item) => item.import_id === id && item.kind === "source");
  if (
    !source ||
    !catalogue.collections.find((item) => item.collection_id === source.collection_id)?.upstream
      ?.draft_home
  )
    return yield* new LibraryChanged({ path });
  const sql = yield* SqlClient.SqlClient;
  const selected = yield* sql<{
    import_id: string;
  }>`SELECT d.import_id FROM library_local_draft_imports d
    JOIN library_imports i USING (import_id) WHERE i.collection_id = ${source.collection_id}`;
  if (selected.length === 1 && selected[0]?.import_id === id) return false;
  yield* sql`DELETE FROM library_local_draft_imports WHERE import_id IN (
    SELECT import_id FROM library_imports WHERE collection_id = ${source.collection_id})`;
  yield* sql`INSERT INTO library_local_draft_imports(import_id) VALUES (${id})`;
  return true;
});

/** Catalogue rows, affected accepted-base rows, setup progress, revision and audit commit together. */
export const saveCatalogue = Effect.fn("Library.saveCatalogue")(function* (
  home: string,
  nextInput: Catalogue,
  baseInput: Catalogue,
  revision: number | null,
  action: HistoryAction,
  draftImport?: ImportId,
) {
  const path = libraryDatabasePath(home);
  return yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      if ((yield* readDatabaseStateRevision(path)).revision !== revision)
        return yield* new LibraryChanged({ path });
      const base = yield* decodeCatalogue(path, baseInput);
      const next = yield* decodeCatalogue(path, nextInput);
      const current = yield* decodeCatalogue(path, yield* loadCatalogueRows());
      if (canonicalJson(current) !== canonicalJson(base))
        return yield* new LibraryChanged({ path });
      if (canonicalJson(current) === canonicalJson(next)) {
        if (draftImport && (yield* selectDraftImport(path, next, draftImport)))
          return yield* advanceLibraryRevision(path);
        return revision;
      }
      const beforeDocument = yield* Schema.decodeUnknownEffect(JsonObject)(current);
      const nextDocument = yield* Schema.decodeUnknownEffect(JsonObject)(next);
      yield* checkCatalogueChange(path, nextDocument, beforeDocument);
      // The only document bootstrap is an absent, empty Library; no owner data is invented.
      if (revision === null) yield* saveDatabaseState(path, emptyLibraryState(), null);
      const enabled = yield* Schema.decodeUnknownEffect(EnabledState)(yield* loadEnabledRows());
      const before = { ...enabled, ...current },
        after = { ...enabled, ...next };
      yield* saveCatalogueBase(path, nextDocument, beforeDocument);
      yield* saveCatalogueRows(nextDocument, beforeDocument);
      if (draftImport) yield* selectDraftImport(path, next, draftImport);
      yield* saveSetupIntentProgress(path, setupIntent(before), setupIntent(after));
      const accepted = yield* advanceLibraryRevision(path);
      yield* saveLibraryHistory(path, action, [
        ...diffCatalogue(current, next),
        ...diffEnabled(
          before,
          after,
          (list) => enabledSkillIds(current, list),
          (list) => enabledSkillIds(next, list),
        ),
      ]);
      return accepted;
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});
