import { Effect, Schema } from "effect";
import { InvalidLibraryState } from "../failures.js";
import { StalePlan } from "../plan-failures.js";
import { SyncAncestry } from "./state-fields.js";
import { canonicalJson, JsonObject } from "../../shared/json.js";
import { emptyLibraryState } from "../library-state.js";
import { libraryDatabasePath } from "./database.js";
import { loadSyncAncestryRows, saveSyncAncestryRows } from "./rows.js";
import {
  advanceLibraryRevision,
  readDatabaseStateRevision,
  saveDatabaseState,
  withLibraryTransaction,
} from "./state-file.js";

export interface SyncAcceptance {
  readonly expectedBase: SyncAncestry | null;
  readonly ancestry: SyncAncestry;
}

/** A proven receipt advances the accepted head without replacing edits made during the request. */
export const saveSyncAncestry = Effect.fn("Library.saveSyncAncestry")(function* (
  home: string,
  request: SyncAcceptance,
) {
  const path = libraryDatabasePath(home);
  yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      const decode = Schema.declare(Schema.is(SyncAncestry));
      const next = yield* Schema.decodeUnknownEffect(JsonObject)(request.ancestry);
      yield* Schema.decodeUnknownEffect(decode)(next);
      const { local, ancestry } = yield* loadSyncAncestryRows();
      if (ancestry !== undefined) yield* Schema.decodeUnknownEffect(decode)(ancestry);
      const { revision } = yield* readDatabaseStateRevision(path);
      if (
        revision === null &&
        (ancestry !== undefined ||
          ["collections", "skills", "collection_versions", "imports", "enabled"].some(
            (field) => Array.isArray(local[field]) && local[field].length > 0,
          ))
      )
        return yield* new InvalidLibraryState({
          path,
          reason: { _tag: "ContentMissing", entry: "library_device" },
        });
      if (canonicalJson(ancestry ?? null) === canonicalJson(next)) return;
      if (canonicalJson(ancestry ?? null) !== canonicalJson(request.expectedBase))
        return yield* new StalePlan({ reason: { _tag: "SyncChanged", part: "base" } });
      if (revision === null) yield* saveDatabaseState(path, emptyLibraryState(), null);
      yield* saveSyncAncestryRows(local, next);
      yield* advanceLibraryRevision(path);
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});
