import { Effect, type Option, Schema } from "effect";
import {
  type BlobStoreService,
  type BlobStorageError,
  type DatabaseError,
  databaseError,
  type DatabaseSqlClient,
} from "../../platform/cloudflare.js";

const ReleaseVisibility = Schema.Literals(["public", "unlisted", "private"]);

const StoredRelease = Schema.Struct({
  release_id: Schema.String,
  version: Schema.String,
  archive_object_key: Schema.String,
  visibility: ReleaseVisibility,
});
interface DownloadableRelease {
  readonly release_id: string;
  readonly version: string;
  readonly visibility: typeof ReleaseVisibility.Type;
  readonly archive: {
    readonly read: Effect.Effect<Option.Option<Uint8Array>, BlobStorageError>;
    readonly stream: Effect.Effect<Option.Option<ReadableStream<Uint8Array>>, BlobStorageError>;
  };
}

class StoredReleaseInvalid extends Schema.TaggedError<StoredReleaseInvalid>()(
  "ReleaseStore.StoredReleaseInvalid",
  { cause: Schema.Defect() },
) {}

export interface Releases {
  readonly findLatestPublic: (input: {
    readonly owner: string;
    readonly slug: string;
  }) => Effect.Effect<DownloadableRelease | null, DatabaseError | StoredReleaseInvalid>;
  readonly findAnonymousDownload: (input: {
    readonly owner: string;
    readonly slug: string;
    readonly version: string;
  }) => Effect.Effect<DownloadableRelease | null, DatabaseError | StoredReleaseInvalid>;
  readonly findExactDownload: (input: {
    readonly owner: string;
    readonly slug: string;
    readonly version: string;
  }) => Effect.Effect<DownloadableRelease | null, DatabaseError | StoredReleaseInvalid>;
  readonly listLatestDownloads: (input: {
    readonly owner: string;
    readonly slug: string;
  }) => Effect.Effect<ReadonlyArray<DownloadableRelease>, DatabaseError | StoredReleaseInvalid>;
}

/** Only Skits constructs release reads; archive storage keys never leave this module. */
export const makeReleaseReads = (sql: DatabaseSqlClient, blobs: BlobStoreService): Releases => {
  const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(databaseError(operation));
  const readArchive = Effect.fn("ReleaseStore.readArchive")((objectKey: string) =>
    blobs.get("read release archive", objectKey),
  );
  const streamArchive = Effect.fn("ReleaseStore.streamArchive")((objectKey: string) =>
    blobs.stream("read release archive", objectKey),
  );
  const decodeRelease = (row: unknown) =>
    Schema.decodeUnknownEffect(StoredRelease)(row).pipe(
      Effect.mapError((cause) => new StoredReleaseInvalid({ cause })),
      Effect.map(
        ({ release_id, version, visibility, archive_object_key }): DownloadableRelease => ({
          release_id,
          version,
          visibility,
          archive: {
            read: readArchive(archive_object_key),
            stream: streamArchive(archive_object_key),
          },
        }),
      ),
    );

  const findAnonymousDownload = Effect.fn("ReleaseStore.findAnonymousDownload")(function* (input: {
    readonly owner: string;
    readonly slug: string;
    readonly version: string;
  }) {
    const latest = input.version === "latest";
    const rows = yield* db(
      "find anonymous release download",
      latest
        ? sql`SELECT release_id, version, archive_object_key, visibility FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND visibility IN ('public', 'unlisted') ORDER BY published_at DESC, rowid DESC LIMIT 1`
        : sql`SELECT release_id, version, archive_object_key, visibility FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND version = ${input.version} AND visibility IN ('public', 'unlisted')`,
    );
    return rows[0] === undefined ? null : yield* decodeRelease(rows[0]);
  });

  const findLatestPublic = Effect.fn("ReleaseStore.findLatestPublic")(function* (input: {
    readonly owner: string;
    readonly slug: string;
  }) {
    const rows = yield* db(
      "find latest public release",
      sql`SELECT release_id, version, archive_object_key, visibility
        FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND visibility = 'public'
        ORDER BY published_at DESC, rowid DESC LIMIT 1`,
    );
    return rows[0] === undefined ? null : yield* decodeRelease(rows[0]);
  });

  const findExactDownload = Effect.fn("ReleaseStore.findExactDownload")(function* (input: {
    readonly owner: string;
    readonly slug: string;
    readonly version: string;
  }) {
    const rows = yield* db(
      "find exact release download",
      sql`SELECT release_id, version, archive_object_key, visibility
        FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND version = ${input.version}`,
    );
    return rows[0] === undefined ? null : yield* decodeRelease(rows[0]);
  });

  const listLatestDownloads = Effect.fn("ReleaseStore.listLatestDownloads")(function* (input: {
    readonly owner: string;
    readonly slug: string;
  }) {
    const rows = yield* db(
      "list release downloads",
      sql`SELECT release_id, version, archive_object_key, visibility
        FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug}
        ORDER BY published_at DESC, rowid DESC`,
    );
    return yield* Effect.forEach(rows, decodeRelease);
  });

  return { findLatestPublic, findAnonymousDownload, findExactDownload, listLatestDownloads };
};
