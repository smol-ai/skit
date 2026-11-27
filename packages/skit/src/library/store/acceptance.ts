import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SkillAssessmentAcceptance } from "../assessment-acceptance.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { JsonObject } from "../../shared/json.js";
import { Hash } from "../../shared/hash.js";
import { libraryDatabasePath } from "../database.js";
import { insertAcceptanceRow } from "./rows.js";
import type { HistoryAction } from "./history-action.js";
import {
  advanceLibraryRevision,
  saveLibraryHistory,
  readDatabaseStateRevision,
  withLibraryTransaction,
} from "./state-file.js";

/** Each accepted finding is one immutable fact; never deduplicate or rewrite earlier evidence. */
export const saveAcceptance = Effect.fn("Library.saveAcceptance")(function* (
  home: string,
  input: SkillAssessmentAcceptance,
  revision: number,
  action: HistoryAction,
) {
  const path = libraryDatabasePath(home);
  return yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      if ((yield* readDatabaseStateRevision(path)).revision !== revision)
        return yield* new LibraryChanged({ path });
      const document = yield* Schema.decodeUnknownEffect(JsonObject)(input);
      const acceptance = yield* Schema.decodeUnknownEffect(SkillAssessmentAcceptance, {
        onExcessProperty: "error",
      })(document);
      const sql = yield* SqlClient.SqlClient;
      const versions =
        yield* sql`SELECT artifact_hash FROM library_skill_versions WHERE skill_version_id=${acceptance.skill_version_id}`;
      const stored = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ artifact_hash: Hash })),
      )(versions);
      if (stored.length !== 1 || stored[0]?.artifact_hash !== acceptance.artifactContentHash)
        return yield* new LibraryChanged({ path });
      yield* insertAcceptanceRow(document);
      // Remember presence even if a document-boundary operation later empties this list.
      yield* sql`UPDATE library_device
        SET assessment_acceptances_present=1 WHERE id=1`;
      const accepted = yield* advanceLibraryRevision(path);
      yield* saveLibraryHistory(path, action, [
        {
          entity: "version",
          id: acceptance.skill_version_id,
          action: "security-finding-accepted",
          digest: acceptance.fingerprint,
          after: JSON.stringify(document),
        },
      ]);
      return accepted;
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});
