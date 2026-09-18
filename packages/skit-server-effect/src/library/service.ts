import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { Principal } from "../auth/authentication.js";
import { Authorization, type AuthorizationService } from "../authorization/service.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";
import { NativeCrypto } from "../platform/native-crypto.js";
import { Library, LibraryManifest } from "./contracts.js";
import { findOwnedLibrary } from "./owner.js";

const LibraryRow = Schema.Struct({
  library_id: Schema.String,
  owner_subject_kind: Schema.Literals(["principal", "team"]),
  owner_subject_id: Schema.String,
  current_revision_id: Schema.NullOr(Schema.String),
});
const RevisionRow = Schema.Struct({ manifest_json: Schema.String });
const StoredManifest = Schema.fromJsonString(LibraryManifest);

export class LibraryRevisionMissing extends Schema.TaggedError<LibraryRevisionMissing>()(
  "Library.RevisionMissing",
  {},
) {}
export class LibraryCreateFailed extends Schema.TaggedError<LibraryCreateFailed>()(
  "Library.CreateFailed",
  {},
) {}
export class LibraryRevisionConflict extends Schema.TaggedError<LibraryRevisionConflict>()(
  "Library.RevisionConflict",
  {},
) {}

export interface LibraryService {
  readonly readDefault: (
    principal: Principal,
  ) => Effect.Effect<Library | undefined, DatabaseError | LibraryRevisionMissing>;
  readonly readById: (
    principal: Principal,
    libraryId: string,
  ) => Effect.Effect<Library | undefined, DatabaseError | LibraryRevisionMissing>;
  readonly write: (
    principal: Principal,
    expectedRevisionId: string | null | undefined,
    manifest: LibraryManifest,
  ) => Effect.Effect<Library, DatabaseError | LibraryCreateFailed | LibraryRevisionConflict>;
}

export class Libraries extends Context.Service<Libraries, LibraryService>()(
  "@skit-server-effect/Libraries",
) {}

export const layer = Layer.effect(
  Libraries,
  Effect.gen(function* () {
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const authorization: AuthorizationService = yield* Authorization;
    const crypto = yield* NativeCrypto;
    const clock = yield* Clock.Clock;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));

    const decodeLibrary = (operation: string, row: unknown) =>
      Schema.decodeUnknownEffect(LibraryRow)(row).pipe(
        Effect.mapError((cause) => new DatabaseError({ operation, cause })),
      );
    const defaultLibrary = (principal: Principal, create: boolean) =>
      findOwnedLibrary({
        sql,
        principal,
        create,
        clock,
        randomUUID: () => crypto.randomUUID(),
      });

    const readRevision = Effect.fn("Libraries.readRevision")(function* (library: {
      readonly library_id: string;
      readonly current_revision_id: string;
    }) {
      const revisions = yield* db(
        "read library revision",
        sql`SELECT manifest_json FROM library_revisions WHERE revision_id = ${library.current_revision_id}`,
      );
      if (revisions[0] === undefined) return yield* new LibraryRevisionMissing();
      const revision = yield* Schema.decodeUnknownEffect(RevisionRow)(revisions[0]).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode library revision", cause }),
        ),
      );
      const manifest = yield* Schema.decodeUnknownEffect(StoredManifest)(
        revision.manifest_json,
      ).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode library manifest", cause }),
        ),
      );
      return { library_id: library.library_id, revision_id: library.current_revision_id, manifest };
    });

    const readDefault = Effect.fn("Libraries.readDefault")(function* (principal: Principal) {
      const library = yield* defaultLibrary(principal, false);
      if (library?.current_revision_id === null || library === undefined) return undefined;
      return yield* readRevision({
        library_id: library.library_id,
        current_revision_id: library.current_revision_id,
      });
    });

    const readById = Effect.fn("Libraries.readById")(function* (
      principal: Principal,
      libraryId: string,
    ) {
      const libraries = yield* db(
        "find shared library",
        sql`SELECT library_id, owner_subject_kind, owner_subject_id, current_revision_id
          FROM libraries WHERE library_id = ${libraryId}`,
      );
      if (libraries[0] === undefined) return undefined;
      const library = yield* decodeLibrary("decode shared library", libraries[0]);
      if (library.current_revision_id === null) return undefined;
      const owns =
        library.owner_subject_kind === "principal" && library.owner_subject_id === principal.id;
      if (!owns && !(yield* authorization.hasGrant(principal, "library", libraryId, "read")))
        return undefined;
      return yield* readRevision({
        library_id: library.library_id,
        current_revision_id: library.current_revision_id,
      });
    });

    const write = Effect.fn("Libraries.write")(function* (
      principal: Principal,
      expectedRevisionId: string | null | undefined,
      manifest: LibraryManifest,
    ) {
      const library = yield* defaultLibrary(principal, true);
      if (library === undefined) return yield* new LibraryCreateFailed();
      const expected = expectedRevisionId ?? null;
      if (library.current_revision_id !== expected) return yield* new LibraryRevisionConflict();
      const revisionId = `library_revision_${crypto.randomUUID().replaceAll("-", "")}`;
      const now = new Date(yield* clock.currentTimeMillis).toISOString();
      const manifestJson = JSON.stringify(manifest);
      const results = yield* db(
        "write library revision",
        sql.batch([
          sql`INSERT INTO library_revisions
            (revision_id, library_id, parent_revision_id, manifest_json, created_at)
            SELECT ${revisionId}, ${library.library_id}, ${expected}, ${manifestJson}, ${now}
            WHERE EXISTS (
              SELECT 1 FROM libraries
              WHERE library_id = ${library.library_id} AND current_revision_id IS ${expected}
            )
            RETURNING revision_id`,
          sql`UPDATE libraries SET current_revision_id = ${revisionId}, updated_at = ${now}
            WHERE library_id = ${library.library_id} AND current_revision_id IS ${expected}
              AND EXISTS (SELECT 1 FROM library_revisions WHERE revision_id = ${revisionId})
            RETURNING library_id`,
        ]),
      );
      if (results[0]?.length !== 1 || results[1]?.length !== 1)
        return yield* new LibraryRevisionConflict();
      return { library_id: library.library_id, revision_id: revisionId, manifest };
    });

    return Libraries.of({ readDefault, readById, write });
  }),
);
