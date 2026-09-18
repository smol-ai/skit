import { Clock, Context, Crypto, Effect, Layer, PlatformError, Schema } from "effect";
import { D1Client } from "@effect/sql-d1";
import {
  SnapshotArchive,
  SnapshotArchiveInvalid,
  verifySnapshotArchiveEffect,
} from "@smolai/skit-core/universal/consumer";
import type { Principal } from "../auth/authentication.js";
import { Authorization } from "../authorization/service.js";
import {
  BlobStorageError,
  DatabaseError,
  blobStorageEffectFrom,
  databaseError,
  r2BodyEffect,
  Bindings,
} from "../platform/cloudflare.js";
import { NativeCrypto } from "../platform/native-crypto.js";
import { decodeOwnedLibrary, findOwnedLibrary } from "./owner.js";

const SnapshotRow = Schema.Struct({
  status: Schema.Literals(["pending", "ready"]),
  r2_key: Schema.String,
});
const JsonUnknown = Schema.fromJsonString(Schema.Unknown);

export class SnapshotMissing extends Schema.TaggedError<SnapshotMissing>()(
  "Library.SnapshotMissing",
  {},
) {}
export class SnapshotForbidden extends Schema.TaggedError<SnapshotForbidden>()(
  "Library.SnapshotForbidden",
  {},
) {}
export class SnapshotStoreInvalid extends Schema.TaggedError<SnapshotStoreInvalid>()(
  "Library.SnapshotStoreInvalid",
  {},
) {}

type SnapshotFailure =
  | DatabaseError
  | BlobStorageError
  | PlatformError.PlatformError
  | SnapshotArchiveInvalid
  | SnapshotStoreInvalid;
export interface SnapshotService {
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
export class LibrarySnapshots extends Context.Service<LibrarySnapshots, SnapshotService>()(
  "@skit-server-effect/LibrarySnapshots",
) {}

export const layer = Layer.effect(
  LibrarySnapshots,
  Effect.gen(function* () {
    const bindings = yield* Bindings;
    const sql = yield* D1Client.D1Client;
    const authorization = yield* Authorization;
    const crypto = yield* Crypto.Crypto;
    const clock = yield* Clock.Clock;
    const nativeCrypto = yield* NativeCrypto;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
    const blob = <A>(operation: string, run: (bucket: R2Bucket) => Promise<A>) =>
      blobStorageEffectFrom(bindings.blobs, operation, run);
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
      const object = yield* blob("read snapshot object", (bucket) => bucket.get(key));
      if (object === null || !("body" in object)) return yield* new SnapshotStoreInvalid();
      const json = yield* r2BodyEffect("read snapshot body", () => object.text());
      const value = yield* Schema.decodeUnknownEffect(JsonUnknown)(json).pipe(
        Effect.mapError(() => new SnapshotStoreInvalid()),
      );
      return yield* verifySnapshotArchiveEffect(value).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
    });
    const ownDefault = (principal: Principal) =>
      findOwnedLibrary({
        sql,
        principal,
        create: true,
        clock,
        randomUUID: () => nativeCrypto.randomUUID(),
      }).pipe(
        Effect.flatMap((library) =>
          library === undefined ? Effect.fail(new SnapshotStoreInvalid()) : Effect.succeed(library),
        ),
      );
    const upload = Effect.fn("LibrarySnapshots.upload")(function* (
      principal: Principal,
      archive: SnapshotArchive,
    ) {
      const verified = yield* verifySnapshotArchiveEffect(archive).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
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
      const put = yield* blob("write immutable snapshot", (bucket) =>
        bucket.put(key, bytes, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: "application/json" },
        }),
      );
      const retained = yield* readObject(key);
      if (retained.archive.digest !== digest) return yield* new SnapshotStoreInvalid();
      yield* db(
        "ready snapshot",
        sql`UPDATE library_snapshots SET status = 'ready', size_bytes = ${bytes.length}, ready_at = ${now}
              WHERE library_id = ${library.library_id}
                AND snapshot_digest = ${digest}
                AND status = 'pending'`,
      );
      return { library_id: library.library_id, snapshot_digest: digest, reused: put === null };
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
      const owns =
        library.owner_subject_kind === "principal" && library.owner_subject_id === principal.id;
      if (!owns && !(yield* authorization.hasGrant(principal, "library", libraryId, "read")))
        return yield* new SnapshotForbidden();
      const snapshot = yield* snapshotRow(libraryId, digest);
      if (snapshot?.status !== "ready") return yield* new SnapshotMissing();
      const retained = yield* readObject(snapshot.r2_key);
      if (retained.archive.digest !== digest) return yield* new SnapshotStoreInvalid();
      return retained.archive;
    });
    return LibrarySnapshots.of({ upload, download });
  }),
);
