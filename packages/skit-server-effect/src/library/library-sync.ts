import { Clock, Context, Effect, Layer, Schema } from "effect";
import { D1Client } from "@effect/sql-d1";
import {
  LegacyLibraryManifestV2,
  LibraryManifest,
  LibraryHead,
  LibraryReceipt,
} from "@smolai/skit-core/universal/consumer";
import type { Principal } from "../auth/authentication.js";
import { DatabaseError, databaseError } from "../platform/cloudflare.js";
import { NativeCrypto } from "../platform/native-crypto.js";
import { findOwnedLibrary } from "./owner.js";

const RevisionRow = Schema.Struct({ manifest_json: Schema.String });
const CountRow = Schema.Struct({ n: Schema.Number });
const StoredManifest = Schema.fromJsonString(
  Schema.Union([LibraryManifest, LegacyLibraryManifestV2]),
);

export class LibraryRevisionConflict extends Schema.TaggedError<LibraryRevisionConflict>()(
  "Library.LibraryRevisionConflict",
  {},
) {}
export class LibrarySnapshotMissing extends Schema.TaggedError<LibrarySnapshotMissing>()(
  "Library.LibrarySnapshotMissing",
  { digest: Schema.String },
) {}
export class LibraryRevisionInvalid extends Schema.TaggedError<LibraryRevisionInvalid>()(
  "Library.LibraryRevisionInvalid",
  {},
) {}
export interface LibrarySyncService {
  readonly read: (
    principal: Principal,
  ) => Effect.Effect<LibraryHead | undefined, DatabaseError | LibraryRevisionInvalid>;
  readonly write: (
    principal: Principal,
    expected: string | null,
    manifest: LibraryManifest,
  ) => Effect.Effect<
    LibraryReceipt,
    DatabaseError | LibraryRevisionInvalid | LibraryRevisionConflict | LibrarySnapshotMissing
  >;
}
export class LibrarySync extends Context.Service<LibrarySync, LibrarySyncService>()(
  "@skit-server-effect/LibrarySync",
) {}

export const layer = Layer.effect(
  LibrarySync,
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const clock = yield* Clock.Clock;
    const crypto = yield* NativeCrypto;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
    const own = (principal: Principal, create: boolean) =>
      findOwnedLibrary({
        sql,
        principal,
        create,
        clock,
        randomUUID: () => crypto.randomUUID(),
      });
    const revision = Effect.fn("LibrarySync.revision")(function* (id: string) {
      const rows = yield* db(
        "read portable revision",
        sql`SELECT manifest_json FROM library_revisions WHERE revision_id = ${id}`,
      );
      if (rows[0] === undefined) return yield* new LibraryRevisionInvalid();
      return yield* Schema.decodeUnknownEffect(RevisionRow)(rows[0]).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode portable revision row", cause }),
        ),
      );
    });
    const read = Effect.fn("LibrarySync.read")(function* (principal: Principal) {
      const library = yield* own(principal, false);
      if (library?.current_revision_id === null || library === undefined) return undefined;
      const record = yield* revision(library.current_revision_id);
      const manifest = yield* Schema.decodeUnknownEffect(StoredManifest)(record.manifest_json).pipe(
        Effect.mapError(() => new LibraryRevisionInvalid()),
      );
      return { library_id: library.library_id, revision_id: library.current_revision_id, manifest };
    });
    const write = Effect.fn("LibrarySync.write")(function* (
      principal: Principal,
      expected: string | null,
      manifest: LibraryManifest,
    ) {
      const library = yield* own(principal, true);
      if (library === undefined) return yield* new LibraryRevisionInvalid();
      if (library.current_revision_id !== expected) return yield* new LibraryRevisionConflict();
      const json = JSON.stringify(manifest);
      if (expected !== null && (yield* revision(expected)).manifest_json === json)
        return { library_id: library.library_id, revision_id: expected, manifest };
      const digests = [...new Set(manifest.snapshot_digests)];
      for (const digest of digests) {
        const rows = yield* db(
          "check ready snapshot",
          sql`SELECT COUNT(*) AS n FROM library_snapshots
                WHERE library_id = ${library.library_id}
                  AND snapshot_digest = ${digest}
                  AND status = 'ready'`,
        );
        const count = yield* Schema.decodeUnknownEffect(CountRow)(rows[0]).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode snapshot count", cause }),
          ),
        );
        if (count.n !== 1) return yield* new LibrarySnapshotMissing({ digest });
      }
      const id = `library_revision_${crypto.randomUUID().replaceAll("-", "")}`;
      const now = new Date(yield* clock.currentTimeMillis).toISOString();
      const results = yield* db(
        "commit portable Library revision",
        sql.batch([
          sql`INSERT INTO library_revisions
               (revision_id, library_id, parent_revision_id, manifest_json, created_at)
               SELECT ${id}, ${library.library_id}, ${expected}, ${json}, ${now}
               WHERE EXISTS (SELECT 1 FROM libraries WHERE library_id = ${library.library_id} AND current_revision_id IS ${expected})
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(${json}, '$.snapshot_digests') AS required
                 LEFT JOIN library_snapshots AS snapshot
                   ON snapshot.library_id = ${library.library_id}
                  AND snapshot.snapshot_digest = required.value
                  AND snapshot.status = 'ready'
                 WHERE snapshot.snapshot_digest IS NULL
               )
               RETURNING revision_id`,
          sql`UPDATE libraries SET current_revision_id = ${id}, updated_at = ${now}
              WHERE library_id = ${library.library_id} AND current_revision_id IS ${expected}
                AND EXISTS (SELECT 1 FROM library_revisions WHERE revision_id = ${id})
              RETURNING library_id`,
        ]),
      );
      if (results[0]?.length !== 1 || results[1]?.length !== 1)
        return yield* new LibraryRevisionConflict();
      return { library_id: library.library_id, revision_id: id, manifest };
    });
    return LibrarySync.of({ read, write });
  }),
);
