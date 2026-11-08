import { Clock, Effect, Option, PlatformError, Schema } from "effect";
import { Digest } from "effect/crypto";
import {
  SnapshotArchive,
  SnapshotArchiveInvalid,
  verifySnapshotArchive,
} from "@smolai/skit-core/universal/consumer";
import type { Principal } from "../../identity/service.js";
import type { TeamsService } from "../../teams/service.js";
import {
  type BlobStoreService,
  type DatabaseSqlClient,
  BlobStorageError,
  DatabaseError,
  databaseError,
} from "../../platform/cloudflare.js";
import { decodeOwnedLibrary, type FindLibrary } from "./owned.js";

const SnapshotRow = Schema.Struct({
  status: Schema.Literals(["pending", "ready"]),
  r2_key: Schema.String,
});
const JsonUnknown = Schema.fromJsonString(Schema.Unknown);

class SnapshotMissing extends Schema.TaggedError<
  SnapshotMissing,
  { readonly brand: unique symbol }
>()("Library.SnapshotMissing", {}) {}
class SnapshotForbidden extends Schema.TaggedError<
  SnapshotForbidden,
  { readonly brand: unique symbol }
>()("Library.SnapshotForbidden", {}) {}
class SnapshotStoreInvalid extends Schema.TaggedError<
  SnapshotStoreInvalid,
  { readonly brand: unique symbol }
>()("Library.SnapshotStoreInvalid", {}) {}

type SnapshotFailure =
  | DatabaseError
  | BlobStorageError
  | PlatformError.PlatformError
  | SnapshotArchiveInvalid
  | SnapshotStoreInvalid;
export interface Snapshots {
  readonly upload: (
    principal: Principal,
    archive: SnapshotArchive,
  ) => Effect.Effect<
    { library_id: string; snapshot_digest: string; reused: boolean },
    SnapshotFailure
  >;
  readonly download: (
    principal: Principal,
    libraryId: string,
    digest: string,
  ) => Effect.Effect<SnapshotArchive, SnapshotFailure | SnapshotMissing | SnapshotForbidden>;
}
/** Snapshot reservation, immutable upload and reads share ServerLibrary's storage and lookup. */
export const makeSnapshots = (
  sql: DatabaseSqlClient,
  blobs: BlobStoreService,
  teams: Pick<TeamsService, "isMember">,
  digests: Digest.Digest["Service"],
  clock: Clock.Clock,
  own: FindLibrary,
): Snapshots => {
  const db = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(databaseError(operation));
  const snapshotRow = Effect.fn("LibrarySnapshots.row")(function* (
    libraryId: string,
    digest: string,
  ) {
    const rows = yield* db(
      "read snapshot row",
      sql`SELECT status, r2_key FROM library_snapshots
            WHERE library_id = ${libraryId} AND snapshot_digest = ${digest}`,
    );
    return rows[0] === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(SnapshotRow)(rows[0]).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode snapshot row", cause }),
          ),
        );
  });
  const readObject = Effect.fn("LibrarySnapshots.readObject")(function* (key: string) {
    const object = yield* blobs.get("read snapshot object", key);
    if (Option.isNone(object)) return yield* new SnapshotStoreInvalid();
    const json = new TextDecoder().decode(object.value);
    const value = yield* Schema.decodeEffect(JsonUnknown)(json).pipe(
      Effect.mapError(() => new SnapshotStoreInvalid()),
    );
    return yield* verifySnapshotArchive(value).pipe(Effect.provideService(Digest.Digest, digests));
  });
  const ownDefault = (principal: Principal) =>
    own(principal, true).pipe(
      Effect.filterOrFail(
        (library) => library !== undefined,
        () => new SnapshotStoreInvalid(),
      ),
    );
  const upload = Effect.fn("LibrarySnapshots.upload")(function* (
    principal: Principal,
    archive: SnapshotArchive,
  ) {
    const verified = yield* verifySnapshotArchive(archive).pipe(
      Effect.provideService(Digest.Digest, digests),
    );
    const library = yield* ownDefault(principal);
    const digest = verified.archive.digest;
    const key = `${library.library_id}/${digest}`;
    if ((yield* snapshotRow(library.library_id, digest))?.status === "ready")
      return { library_id: library.library_id, snapshot_digest: digest, reused: true };
    const now = new Date(yield* clock.currentTimeMillis).toISOString();
    yield* db(
      "reserve snapshot",
      sql`INSERT OR IGNORE INTO library_snapshots
            (library_id, snapshot_digest, status, r2_key, created_at)
            VALUES (${library.library_id}, ${digest}, 'pending', ${key}, ${now})`,
    );
    const bytes = new TextEncoder().encode(JSON.stringify(verified.archive));
    const written = yield* blobs.put("write immutable snapshot", key, bytes, {
      contentType: "application/json",
      onlyIfAbsent: true,
    });
    const imported = yield* readObject(key);
    if (imported.archive.digest !== digest) return yield* new SnapshotStoreInvalid();
    yield* db(
      "ready snapshot",
      sql`UPDATE library_snapshots SET status = 'ready', size_bytes = ${bytes.length}, ready_at = ${now}
            WHERE library_id = ${library.library_id}
              AND snapshot_digest = ${digest}
              AND status = 'pending'`,
    );
    return { library_id: library.library_id, snapshot_digest: digest, reused: !written };
  });
  const download = Effect.fn("LibrarySnapshots.download")(function* (
    principal: Principal,
    libraryId: string,
    digest: string,
  ) {
    const rows = yield* db(
      "read Library owner",
      sql`SELECT library_id, owner_subject_kind, owner_subject_id, current_revision_id
            FROM libraries WHERE library_id = ${libraryId}`,
    );
    if (rows[0] === undefined) return yield* new SnapshotMissing();
    const library = yield* decodeOwnedLibrary(rows[0]);
    const allowed =
      library.owner_subject_kind === "principal"
        ? library.owner_subject_id === principal.id
        : yield* teams.isMember(principal, library.owner_subject_id);
    if (!allowed) return yield* new SnapshotForbidden();
    const snapshot = yield* snapshotRow(libraryId, digest);
    if (snapshot?.status !== "ready") return yield* new SnapshotMissing();
    const imported = yield* readObject(snapshot.r2_key);
    if (imported.archive.digest !== digest) return yield* new SnapshotStoreInvalid();
    return imported.archive;
  });
  return { upload, download };
};
