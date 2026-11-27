import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../database.js";
import { loadLibraryListing } from "./rows.js";
import { AbsoluteDevicePath, InstalledSkill } from "../device-state.js";
import { SkillId, CollectionId } from "../entity-ids.js";
import { InstallDestination } from "../../installed-skills/destination.js";
import { InvalidLibraryState } from "../failures.js";

/** Catalogue and selection rows from one read transaction, without a Library document. */
export const readLibraryListing = Effect.fn("Library.readListing")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path)))
    return {
      collections: [],
      skills: [],
      collection_versions: [],
      imports: [],
      enabled: [],
      repositories: [],
      installed_skills: [],
    };
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(loadLibraryListing(path));
    }),
    true,
  );
});

/** Named installed folders need only the installed rows and their Skills' names. */
export const readInstalledSkillList = Effect.fn("Library.readInstalledSkillList")(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path))) return [];
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT i.skill_id AS skillId, s.name, i.destination, i.path, i.status
      FROM library_installed_skills AS i JOIN library_skills AS s ON s.skill_id=i.skill_id
      ORDER BY i.rowid`;
      return yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            skillId: SkillId,
            name: Schema.String,
            destination: InstallDestination,
            path: AbsoluteDevicePath,
            status: Schema.Union(InstalledSkill.members.map((member) => member.fields.status)),
          }),
        ),
      )(rows).pipe(
        Effect.mapError(
          (failure) =>
            new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
        ),
      );
    }),
    true,
  );
});

/** Find lock-backed Collections directly in their imports. */
export const readSkillsShCollectionIds = Effect.fn("Library.readSkillsShCollectionIds")(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path))) return [];
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT DISTINCT collection_id FROM library_imports AS i
      WHERE EXISTS (SELECT 1 FROM json_each(i.lock_file_entries) AS entry WHERE json_extract(entry.value,'$.type')='skills.sh-lock')
      ORDER BY collection_id`;
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ collection_id: CollectionId })),
      )(rows).pipe(
        Effect.mapError(
          (failure) =>
            new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
        ),
      );
      return decoded.map((row) => row.collection_id);
    }),
    true,
  );
});
